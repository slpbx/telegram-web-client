/* eslint-disable no-console */
import { addCallback } from '../lib/teact/teactn';
import {
  addActionHandler, getActions, getGlobal, setGlobal,
} from '../global';

import type { WorkerMessageEvent } from '../api/gramjs/worker/types';
import type { ApiChatFullInfo, ApiSessionData, ApiUserFullInfo } from '../api/types';
import type { ActionPayloads, GlobalState } from '../global/types';
import { MAIN_THREAD_ID } from '../api/types';

import { getChatAvatarHash } from '../global/helpers';
import { selectThreadReadState } from '../global/selectors/threads';
import { getCurrentTabId } from './establishMultitabRole';
import * as mediaLoader from './mediaLoader';

const INFINITE_LOOP_MARKER = 100;

export type DisplayedProperty = {
  name: string;
  type?: string;
  values: Array<{
    text: string;
    color?: string;
  }>;
};

export function crmChatLog(...args: any[]) {
  console.info('\x1b[44m\x1b[37m[ TGWEB ]\x1b[0m ', ...args);
}

let dcAuthParams: string | undefined;

let resolveSession: (session: ApiSessionData) => void;
const sessionPromise = new Promise<ApiSessionData>(
  (resolve) => {
    resolveSession = resolve;
  },
);

type CurrentState = {
  authState: GlobalState['auth']['state'];
  currentChatId?: string;
  currentChatUnreadCount?: number;
};
const current: CurrentState = {
  authState: undefined,
  currentChatId: undefined,
  currentChatUnreadCount: undefined,
};

async function sendChatOpened(global: GlobalState, chat: GlobalState['chats']['byId'][string] | undefined) {
  const fullInfo: ApiUserFullInfo | ApiChatFullInfo | undefined = chat
    ? global.users.fullInfoById[chat.id] ?? global.chats.fullInfoById[chat.id]
    : undefined;

  let type: 'user' | 'group' | 'other' = 'other';
  switch (chat?.type) {
    case 'chatTypePrivate':
      type = 'user';
      break;
    case 'chatTypeBasicGroup':
    case 'chatTypeSuperGroup':
      type = 'group';
      break;
  }

  const avatarHash = chat ? getChatAvatarHash(chat) : undefined;
  const avatarUrl = avatarHash ? mediaLoader.getFromMemory(avatarHash) : undefined;
  const avatarDataUri = avatarUrl ? await blobUrlToDataURI(avatarUrl) : undefined;

  const info = chat ? {
    type,
    peerId: chat.id,
    username: chat.usernames?.[0]?.username,
    avatar: avatarDataUri,
    fullName: chat.title,
    description: fullInfo && 'bio' in fullInfo
      ? fullInfo.bio
      : (fullInfo && 'about' in fullInfo
        ? fullInfo.about
        : undefined
      ),
  } : undefined;

  sendMessage({
    type: 'chatOpened',
    chat,
    info,
    userId: chat?.id,
    username: chat?.usernames?.[0]?.username,
  });
}

addCallback(() => {
  const global = getGlobal();

  if (global.auth.state !== current.authState) {
    current.authState = global.auth.state;
    sendMessage({
      type: 'authStateLegacy',
      state: current.authState,
    });
  }

  const messageLists = global.byTabId[getCurrentTabId()]?.messageLists;
  const chatId = messageLists?.[messageLists.length - 1]?.chatId;
  const chat = chatId ? global.chats.byId[chatId] : undefined;

  const unreadCount = chat
    ? selectThreadReadState(global, chat.id, MAIN_THREAD_ID)?.unreadCount
    : undefined;

  if (global.isSynced && unreadCount !== current.currentChatUnreadCount) {
    current.currentChatUnreadCount = unreadCount;
    sendMessage({
      type: 'chatUnreadState',
      peerId: chat?.id,
      username: chat?.usernames?.[0]?.username,
      unreadCount,
      synced: global.isSynced,
    });
  }

  // handle opened chat change
  if (chat?.id !== current.currentChatId) {
    current.currentChatId = chat?.id;
    void sendChatOpened(global, chat).catch((e) => console.warn(e));
  }
});

async function callActionWhenAvailable<Action extends keyof ActionPayloads>(
  action: Action,
  data: ActionPayloads[Action],
) {
  let i = 0;
  while (typeof getActions()[action] !== 'function') {
    await new Promise((resolve) => {
      setTimeout(resolve, 100);
    });
    if (i++ >= INFINITE_LOOP_MARKER) {
      return;
    }
  }
  getActions()[action](data as any);
}

window.addEventListener('message', (event) => {
  const isLocalOrigin = process.env.NODE_ENV === 'development'
    && (
      event.origin.startsWith('http://localhost')
      || event.origin.startsWith('http://127.0.0.1')
      || event.origin.startsWith('http://192.168.')
    );

  if (![
    'https://hints-crm.web.app',
    'https://app.crmchat.ai',
  ].includes(event.origin) && !isLocalOrigin) {
    return;
  }

  crmChatLog('Got message from CRMchat', event.data);

  if (event.data.type === 'sessionResponse') {
    dcAuthParams = event.data.authParams;
    resolveSession(event.data.session);
  }
  if (event.data.type === 'openChat') {
    if (event.data.username) {
      callActionWhenAvailable('openChatByUsername', {
        username: event.data.username,
      });
    } else if (event.data.id) {
      callActionWhenAvailable('openChat', {
        id: String(event.data.id),
      });
    }
  }
  if (event.data.type === 'setDisplayedProperties') {
    const global: GlobalState = {
      ...getGlobal(),
      crmchatDisplayedProperties: event.data.displayedProperties,
    };
    setGlobal(global);
  }
});

function sendMessage(data: any) {
  crmChatLog('Sending message to CRMchat', data);
  window.parent.postMessage(data, '*');
}

export async function requestSessionFromCrmChat(): Promise<ApiSessionData> {
  sendMessage({ type: 'sessionRequest' });
  try {
    return await Promise.race([
      sessionPromise,
      new Promise<never>((_, reject) => {
        setTimeout(() => {
          reject(new Error('Session request timed out'));
        }, 20_000);
      }),
    ]);
  } catch (e) {
    sendMessage({ type: 'sessionRequestFailed' });
    throw e;
  }
}

addActionHandler('apiUpdate', (global, actions, update): void => {
  switch (update['@type']) {
    case 'updateAuthorizationState':
      sendMessage({
        type: 'authState',
        state: update.authorizationState,
      });
      break;
    case 'updateConnectionState':
      sendMessage({
        type: 'connectionState',
        state: update.connectionState,
      });
      break;
  }
});

const dcDomain = new URLSearchParams(self.location.search).get('dcDomain') ?? 'dc';

// Patch Worker constructor to pass variables to workers
const OriginalWorker = window.Worker;
window.Worker = class PatchedWorker extends OriginalWorker {
  constructor(url: string | URL, options?: WorkerOptions) {
    const newUrl = url instanceof URL ? url : new URL(url, self.location.href);
    newUrl.searchParams.set('accountId', new URLSearchParams(self.location.search).get('accountId') ?? '');
    newUrl.searchParams.set('_dcAuth', dcAuthParams ?? '');
    newUrl.searchParams.set('_dcDomain', dcDomain);
    super(newUrl, options);

    this.addEventListener('message', (event: WorkerMessageEvent) => {
      const logs = event.data.payloads.filter((payload) => payload.type === 'mtprotoSenderLog');
      if (logs.length > 0) {
        sendMessage({ type: 'mtprotoSenderLogs', logs });
      }
    });
  }
} satisfies typeof Worker;

async function blobUrlToDataURI(blobUrl: string) {
  const resp = await fetch(blobUrl);
  const blob = await resp.blob();

  // Read it as a Data URI via FileReader
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = reject;
    reader.onloadend = () => resolve(reader.result);
    reader.readAsDataURL(blob);
  });
}

const urlParams = new URLSearchParams(window.location.search);
const isChatter = urlParams.get('p') === '0';

export const CAN_DELETE_CHAT = !isChatter;
export const CAN_DELETE_MESSAGES = !isChatter;
export const CAN_ACCESS_SETTINGS = !isChatter;
export const CAN_ACCESS_SERVICE_NOTIFICATIONS = !isChatter;
export const CAN_ACCESS_CHANNEL_SETTINGS = !isChatter;
export const CAN_BLOCK_CONTACT = !isChatter;
export const CAN_MUTE_CHAT = !isChatter;
