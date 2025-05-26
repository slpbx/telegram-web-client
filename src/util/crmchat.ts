/* eslint-disable no-restricted-globals */
/* eslint-disable no-console */
import { addCallback } from '../lib/teact/teactn';
import {
  addActionHandler, getActions, getGlobal, setGlobal,
} from '../global';

import type { ApiChatFullInfo, ApiSessionData, ApiUserFullInfo } from '../api/types';
import type { ActionPayloads, GlobalState } from '../global/types';

import { getChatAvatarHash } from '../global/helpers';
import { getCurrentTabId } from './establishMultitabRole';
import * as mediaLoader from './mediaLoader';

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

type CurrentState = Pick<GlobalState, 'currentUserId'> & {
  messageList?: GlobalState['byTabId'][number]['messageLists'][number];
};
const current: CurrentState = {
  currentUserId: undefined,
  messageList: undefined,
};

addCallback(async () => {
  const global = getGlobal();

  const messageLists = global.byTabId[getCurrentTabId()]?.messageLists;
  const currentList = messageLists?.[messageLists.length - 1];

  if (currentList !== current.messageList) {
    current.messageList = currentList;
    const chat = currentList?.chatId ? global.chats.byId[currentList.chatId] : undefined;
    const fullInfo: ApiUserFullInfo | ApiChatFullInfo | undefined = global.users.fullInfoById[currentList?.chatId]
      ?? global.chats.fullInfoById[currentList?.chatId];

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
});

async function callActionWhenAvailable<Action extends keyof ActionPayloads>(
  action: Action,
  data: ActionPayloads[Action],
) {
  while (typeof getActions()[action] !== 'function') {
    await new Promise((resolve) => {
      setTimeout(resolve, 100);
    });
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
    if (event.data.id) {
      callActionWhenAvailable('openChat', {
        id: String(event.data.id),
      });
    } else if (event.data.username) {
      callActionWhenAvailable('openChatByUsername', {
        username: event.data.username,
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
        }, 15000);
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

// Patch Worker constructor to pass variables to workers
const OriginalWorker = window.Worker;
window.Worker = class PatchedWorker extends OriginalWorker {
  constructor(url: string | URL, options?: WorkerOptions) {
    const newUrl = url instanceof URL ? url : new URL(url, self.location.href);
    newUrl.searchParams.set('accountId', new URLSearchParams(self.location.search).get('accountId') ?? '');
    newUrl.searchParams.set('_dcAuth', dcAuthParams ?? '');
    super(newUrl, options);
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
