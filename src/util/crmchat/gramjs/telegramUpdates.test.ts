import { beforeEach, describe, expect, it } from 'vitest';
import { Api as GramJs } from '../../../lib/gramjs/tl';

import {
  buildGramJsUpdateFromCrmEnvelope,
  clearTelegramUpdateDedupForTests,
  type CrmTelegramUpdateEnvelope,
  isDuplicateNoStateTelegramUpdate,
  rememberNoStateTelegramUpdate,
  reviveTlObject,
} from './telegramUpdates';

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

  it('ignores unknown peer context constructors without dropping the update', () => {
    const update = buildGramJsUpdateFromCrmEnvelope({
      ...envelope({
        _: 'updateNewMessage',
        message: {
          _: 'message',
          id: 8,
          peerId: { _: 'peerUser', userId: '123' },
          message: 'hello',
          date: 1,
        },
        pts: 11,
        ptsCount: 1,
      }),
      users: [
        { _: 'userDoesNotExist', id: '999' },
        { _: 'user', id: '123', self: true, firstName: 'Ada' },
      ],
      chats: [{ _: 'chatDoesNotExist', id: '456' }],
    });

    expect(update).toBeInstanceOf(GramJs.UpdateNewMessage);
    const entities = (update as GramJs.UpdateNewMessage & { _entities?: Array<GramJs.TypeUser | GramJs.TypeChat> })._entities;
    expect(entities).toHaveLength(1);
    expect(entities?.[0]).toBeInstanceOf(GramJs.User);
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

  function channelReadInboxUpdate(maxId = 1, stillUnreadCount = 0) {
    return new GramJs.UpdateReadChannelInbox({
      channelId: 123n,
      maxId,
      stillUnreadCount,
      pts: 10,
    });
  }

  it('does not custom-deduplicate account updates with pts', () => {
    const nativeUpdate = readInboxUpdate();
    const broadcastUpdate = readInboxUpdate();

    expect(isDuplicateNoStateTelegramUpdate(nativeUpdate)).toBe(false);
    rememberNoStateTelegramUpdate(nativeUpdate);
    expect(isDuplicateNoStateTelegramUpdate(broadcastUpdate)).toBe(false);
  });

  it('does not custom-deduplicate channel updates with pts', () => {
    const first = channelMessageUpdate();
    const second = channelMessageUpdate();

    rememberNoStateTelegramUpdate(first);
    expect(isDuplicateNoStateTelegramUpdate(second)).toBe(false);
  });

  it('does not collapse channel read updates with the same pts but different counters', () => {
    const first = channelReadInboxUpdate(1, 2);
    const second = channelReadInboxUpdate(2, 1);

    rememberNoStateTelegramUpdate(first);
    expect(isDuplicateNoStateTelegramUpdate(second)).toBe(false);
  });

  it('does not custom-deduplicate channel read updates without ptsCount', () => {
    const first = channelReadInboxUpdate(1, 2);
    const second = channelReadInboxUpdate(1, 2);

    rememberNoStateTelegramUpdate(first);
    expect(isDuplicateNoStateTelegramUpdate(second)).toBe(false);
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

    rememberNoStateTelegramUpdate(first);
    expect(isDuplicateNoStateTelegramUpdate(second)).toBe(true);
  });
});
