import { beforeEach, describe, expect, it } from '@jest/globals';
import { Api as GramJs } from '../../../lib/gramjs/tl';

import {
  buildGramJsUpdateFromCrmEnvelope,
  clearTelegramUpdateDedupForTests,
  type CrmTelegramUpdateEnvelope,
  isDuplicateTelegramUpdate,
  rememberTelegramUpdate,
  reviveTlObject,
} from './crmTelegramUpdates';

function envelope(
  update: CrmTelegramUpdateEnvelope['update'],
): CrmTelegramUpdateEnvelope {
  return {
    workspaceId: 'workspace-1',
    accountId: 'account-1',
    sourceLayer: 223,
    emittedAt: 1,
    update,
    users: [{ _: 'user', id: '123', self: true, firstName: 'Ada' }],
    chats: [],
    hasMin: false,
  };
}

describe('CRM Telegram updates', () => {
  beforeEach(() => {
    clearTelegramUpdateDedupForTests();
  });

  it('reconstructs TL JSON into GramJS updates with peer entities', () => {
    const update = buildGramJsUpdateFromCrmEnvelope(envelope({
      _: 'updateNewMessage',
      message: {
        _: 'message',
        id: 7,
        peerId: { _: 'peerUser', userId: '123' },
        message: 'hello',
        date: 1,
      },
      pts: 10,
      ptsCount: 1,
    }));

    expect(update).toBeInstanceOf(GramJs.UpdateNewMessage);
    expect((update as GramJs.UpdateNewMessage).message).toBeInstanceOf(GramJs.Message);
    expect(((update as GramJs.UpdateNewMessage).message.peerId as GramJs.PeerUser).userId).toBe(123n);
    expect((update as GramJs.UpdateNewMessage & { _entities?: GramJs.TypeUser[] })._entities?.[0])
      .toBeInstanceOf(GramJs.User);
  });

  it('rejects unknown constructors without throwing during parsing of known fields', () => {
    expect(() => reviveTlObject({ _: 'updateDoesNotExist' })).toThrow(/Unknown Telegram constructor/);
  });

  function readInboxUpdate(pts = 10) {
    return new GramJs.UpdateReadHistoryInbox({
      peer: new GramJs.PeerUser({ userId: 123n }),
      maxId: 1,
      stillUnreadCount: 0,
      pts,
      ptsCount: 1,
    });
  }

  function channelMessageUpdate(pts = 10) {
    return new GramJs.UpdateNewChannelMessage({
      message: new GramJs.Message({
        id: 7,
        peerId: new GramJs.PeerChannel({ channelId: 123n }),
        message: 'hello',
        date: 1,
      }),
      pts,
      ptsCount: 1,
    });
  }

  it('deduplicates separate account updates by pts', () => {
    const nativeUpdate = readInboxUpdate();
    const broadcastUpdate = readInboxUpdate();

    expect(isDuplicateTelegramUpdate(nativeUpdate)).toBe(false);
    rememberTelegramUpdate(nativeUpdate);
    expect(isDuplicateTelegramUpdate(broadcastUpdate)).toBe(true);
  });

  it('deduplicates channel updates by channel pts', () => {
    const first = channelMessageUpdate();
    const second = channelMessageUpdate();

    rememberTelegramUpdate(first);
    expect(isDuplicateTelegramUpdate(second)).toBe(true);
  });

  it('deduplicates no-state updates by short-lived fingerprint', () => {
    const first = new GramJs.UpdateUserStatus({
      userId: 123n,
      status: new GramJs.UserStatusRecently({}),
    });
    const second = new GramJs.UpdateUserStatus({
      userId: 123n,
      status: new GramJs.UserStatusRecently({}),
    });

    rememberTelegramUpdate(first);
    expect(isDuplicateTelegramUpdate(second)).toBe(true);
  });
});
