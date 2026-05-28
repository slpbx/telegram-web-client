import { Buffer } from 'buffer';
import type { Update } from '../../../lib/gramjs/client/TelegramClient';
import { Api as GramJs } from '../../../lib/gramjs/tl';
import apiTl from '../../../lib/gramjs/tl/apiTl';
import {
  type GenerationArgConfig,
  type GenerationEntryConfig,
  parseTl,
} from '../../../lib/gramjs/tl/generationHelpers';
import schemaTl from '../../../lib/gramjs/tl/schemaTl';

export type CrmTlJsonValue =
  | string
  | number
  | boolean
  | null
  | CrmTlJsonValue[]
  | { [key: string]: CrmTlJsonValue };

export type CrmTlJsonObject = {
  _: string;
  [key: string]: CrmTlJsonValue;
};

export type CrmTelegramUpdateEnvelope = {
  workspaceId: string;
  accountId: string;
  sourceLayer: number;
  emittedAt: number;
  update: CrmTlJsonObject;
  users: CrmTlJsonObject[];
  chats: CrmTlJsonObject[];
  hasMin: boolean;
};

type ConstructorArgs = Record<string, unknown>;
type GramJsConstructor = new (args?: ConstructorArgs) => object;
type DedupEntry = { key: string; expiresAt: number };
type HandleUpdate = (update: Update) => void;
type ScheduleDifference = () => void;

const DEDUP_TTL_MS = 2_000;
const DEDUP_MAX_SIZE = 2000;
const DIFFERENCE_INITIAL_DELAY_MS = 1_000;
const DIFFERENCE_MAX_DELAY_MS = 30_000;

const dedupKeys = new Map<string, number>();

let entryCache: Map<string, GenerationEntryConfig> | undefined;
let differenceTimeout: ReturnType<typeof setTimeout> | undefined;
let differenceDelayMs = DIFFERENCE_INITIAL_DELAY_MS;

function getEntryCache() {
  if (!entryCache) {
    entryCache = new Map();
    for (const entry of [...parseTl(apiTl), ...parseTl(schemaTl)]) {
      entryCache.set(getEntryFullName(entry), entry);
    }
  }
  return entryCache;
}

function getEntryFullName(entry: GenerationEntryConfig) {
  return [entry.namespace, entry.name].filter(Boolean).join('.');
}

function upperFirst(value: string) {
  return value ? `${value[0].toUpperCase()}${value.slice(1)}` : value;
}

function constructorNameToClassPath(name: string) {
  const parts = name.split('.');
  const constructorName = parts.pop();
  if (!constructorName) return name;
  return [...parts, upperFirst(constructorName)].join('.');
}

function resolveGramJsConstructor(name: string): GramJsConstructor | undefined {
  const path = constructorNameToClassPath(name).split('.');
  let current: unknown = GramJs;
  for (const part of path) {
    if (typeof current !== 'object' && typeof current !== 'function') {
      return undefined;
    }
    if (!current || !(part in current)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return typeof current === 'function' ? (current as GramJsConstructor) : undefined;
}

function getArgConfig(name: string): Record<string, GenerationArgConfig> | undefined {
  return getEntryCache().get(constructorNameToClassPath(name))?.argsConfig;
}

function isObjectValue(value: unknown): value is object {
  return typeof value === 'object' && Boolean(value);
}

function isRecordValue(value: unknown): value is Record<string, CrmTlJsonValue> {
  return isObjectValue(value) && !Array.isArray(value);
}

function isTlJsonObject(value: CrmTlJsonValue): value is CrmTlJsonObject {
  return (
    isRecordValue(value)
    && '_' in value
    && typeof value._ === 'string'
  );
}

function revivePrimitiveByType(value: CrmTlJsonValue, type?: string): unknown {
  if (type === 'long') {
    if (typeof value === 'string' || typeof value === 'number') {
      return BigInt(value);
    }
  }

  if (type === 'bytes') {
    if (typeof value === 'string') {
      return Buffer.from(value, 'base64');
    }
  }

  if (type === 'int128' || type === 'int256') {
    if (typeof value === 'string') {
      return BigInt(`0x${Buffer.from(value, 'base64').toString('hex')}`);
    }
  }

  return value;
}

function reviveValue(value: CrmTlJsonValue, config?: GenerationArgConfig): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => reviveValue(item, config && { ...config, isVector: false }));
  }

  if (isTlJsonObject(value)) {
    return reviveTlObject(value);
  }

  return revivePrimitiveByType(value, config?.type);
}

export function reviveTlObject(value: CrmTlJsonObject): object {
  const Ctor = resolveGramJsConstructor(value._);
  if (!Ctor) {
    throw new Error(`Unknown Telegram constructor: ${value._}`);
  }

  const argConfig = getArgConfig(value._);
  const args: ConstructorArgs = {};
  for (const [key, fieldValue] of Object.entries(value)) {
    if (key === '_') continue;
    args[key] = reviveValue(fieldValue, argConfig?.[key]);
  }

  return new Ctor(args);
}

function isProcessableUpdate(value: object): value is Update {
  return (
    value instanceof GramJs.Updates
    || value instanceof GramJs.UpdatesCombined
    || value instanceof GramJs.UpdatesTooLong
    || value instanceof GramJs.UpdateShort
    || value instanceof GramJs.UpdateShortMessage
    || value instanceof GramJs.UpdateShortChatMessage
    || value instanceof GramJs.UpdateShortSentMessage
    || (
      'className' in value
      && typeof value.className === 'string'
      && value.className.startsWith('Update')
    )
  );
}

function assignEntities(update: Update, entities: Array<GramJs.TypeUser | GramJs.TypeChat>) {
  if (update instanceof GramJs.Updates || update instanceof GramJs.UpdatesCombined) return update;
  Object.assign(update, { _entities: entities });
  return update;
}

function buildMessageUpdate(message: GramJs.Message | GramJs.MessageService): GramJs.UpdateNewMessage {
  const update = new GramJs.UpdateNewMessage({ message, pts: 0, ptsCount: 0 });
  delete (update as Partial<GramJs.UpdateNewMessage>).pts;
  delete (update as Partial<GramJs.UpdateNewMessage>).ptsCount;
  return update;
}

export function buildGramJsUpdateFromCrmEnvelope(envelope: CrmTelegramUpdateEnvelope): Update {
  const revivedUpdate = reviveTlObject(envelope.update);
  const users = envelope.users
    .map((user) => reviveTlObject(user))
    .filter((user): user is GramJs.TypeUser => (
      user instanceof GramJs.User || user instanceof GramJs.UserEmpty
    ));
  const chats = envelope.chats
    .map((chat) => reviveTlObject(chat))
    .filter((chat): chat is GramJs.TypeChat => (
      chat instanceof GramJs.Chat
      || chat instanceof GramJs.ChatEmpty
      || chat instanceof GramJs.ChatForbidden
      || chat instanceof GramJs.Channel
      || chat instanceof GramJs.ChannelForbidden
    ));

  if (revivedUpdate instanceof GramJs.Message || revivedUpdate instanceof GramJs.MessageService) {
    return assignEntities(buildMessageUpdate(revivedUpdate), [...users, ...chats]);
  }

  if (!isProcessableUpdate(revivedUpdate)) {
    throw new Error(`Unsupported Telegram update constructor: ${envelope.update._}`);
  }

  if (revivedUpdate instanceof GramJs.Updates || revivedUpdate instanceof GramJs.UpdatesCombined) {
    revivedUpdate.users = users;
    revivedUpdate.chats = chats;
    return revivedUpdate;
  }

  return assignEntities(revivedUpdate, [...users, ...chats]);
}

function stringifyForFingerprint(value: unknown) {
  return JSON.stringify(value, (_key, nestedValue: unknown) => (
    typeof nestedValue === 'bigint' ? nestedValue.toString() : nestedValue
  ));
}

function buildNoStateFingerprint(update: Update) {
  const className = 'className' in update && typeof update.className === 'string' ? update.className : 'unknown';
  if (
    (update instanceof GramJs.UpdateNewMessage || update instanceof GramJs.UpdateNewChannelMessage)
    && update.message instanceof GramJs.Message
  ) {
    const peer = update.message.peerId;
    const peerKey = peer && 'className' in peer ? stringifyForFingerprint(peer) : '';
    return `message:${className}:${peerKey}:${update.message.id}`;
  }
  return `nostate:${className}:${stringifyForFingerprint(update)}`;
}

function isDedupCandidate(update: unknown): update is Update {
  return (
    isObjectValue(update)
    && (
      update instanceof GramJs.Updates
      || update instanceof GramJs.UpdatesCombined
      || update instanceof GramJs.UpdatesTooLong
      || update instanceof GramJs.UpdateShort
      || update instanceof GramJs.UpdateShortMessage
      || update instanceof GramJs.UpdateShortChatMessage
      || update instanceof GramJs.UpdateShortSentMessage
      || (
        'className' in update
        && typeof update.className === 'string'
        && update.className.startsWith('Update')
      )
    )
  );
}

export function isNoStateTelegramUpdate(update: unknown): update is Update {
  if (!isDedupCandidate(update)) return false;
  if (
    update instanceof GramJs.Updates
    || update instanceof GramJs.UpdatesCombined
    || update instanceof GramJs.UpdatesTooLong
    || update instanceof GramJs.UpdateShort
  ) {
    return false;
  }

  return !(
    'pts' in update
    || 'qts' in update
    || 'seq' in update
    || 'seqStart' in update
  );
}

export function getTelegramUpdateDedupKeys(update: Update): string[] {
  return isNoStateTelegramUpdate(update) ? [buildNoStateFingerprint(update)] : [];
}

function pruneDedupKeys(now: number) {
  if (dedupKeys.size <= DEDUP_MAX_SIZE) return;

  const expired: DedupEntry[] = [];
  for (const [key, expiresAt] of dedupKeys) {
    if (expiresAt <= now) expired.push({ key, expiresAt });
  }
  expired.forEach(({ key }) => dedupKeys.delete(key));

  if (dedupKeys.size <= DEDUP_MAX_SIZE) return;
  const oldest = [...dedupKeys.entries()]
    .sort((a, b) => a[1] - b[1])
    .slice(0, dedupKeys.size - DEDUP_MAX_SIZE);
  oldest.forEach(([key]) => dedupKeys.delete(key));
}

export function rememberNoStateTelegramUpdate(update: unknown) {
  if (!isNoStateTelegramUpdate(update)) return;
  const now = Date.now();
  pruneDedupKeys(now);
  for (const key of getTelegramUpdateDedupKeys(update)) {
    dedupKeys.set(key, now + DEDUP_TTL_MS);
  }
}

export function isDuplicateNoStateTelegramUpdate(update: unknown) {
  if (!isNoStateTelegramUpdate(update)) return false;
  const now = Date.now();
  const keys = getTelegramUpdateDedupKeys(update);
  const duplicate = keys.length > 0 && keys.every((key) => {
    const expiresAt = dedupKeys.get(key);
    return expiresAt !== undefined && expiresAt > now;
  });
  return duplicate;
}

function resetDifferenceBackoff() {
  differenceDelayMs = DIFFERENCE_INITIAL_DELAY_MS;
}

export function clearCrmTelegramUpdateDifferenceFallback() {
  if (differenceTimeout) {
    clearTimeout(differenceTimeout);
    differenceTimeout = undefined;
  }
  resetDifferenceBackoff();
}

function scheduleDifferenceFallback(scheduleDifference: ScheduleDifference) {
  if (differenceTimeout) return;

  const delayMs = differenceDelayMs;
  differenceDelayMs = Math.min(differenceDelayMs * 2, DIFFERENCE_MAX_DELAY_MS);

  differenceTimeout = setTimeout(() => {
    differenceTimeout = undefined;
    scheduleDifference();
  }, delayMs);
}

export function handleCrmTelegramUpdateEnvelope(
  envelope: CrmTelegramUpdateEnvelope,
  handleUpdate: HandleUpdate,
  scheduleDifference: ScheduleDifference,
) {
  try {
    handleUpdate(buildGramJsUpdateFromCrmEnvelope(envelope));
    resetDifferenceBackoff();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[CRMchat] Failed to apply broadcast Telegram update, scheduling difference', {
      workspaceId: envelope.workspaceId,
      accountId: envelope.accountId,
      sourceLayer: envelope.sourceLayer,
      updateType: envelope.update._,
    }, err);
    scheduleDifferenceFallback(scheduleDifference);
  }
}

export function clearTelegramUpdateDedupForTests() {
  dedupKeys.clear();
  clearCrmTelegramUpdateDifferenceFallback();
}
