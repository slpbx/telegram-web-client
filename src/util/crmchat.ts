/* eslint-disable no-restricted-globals */
/* eslint-disable no-console */
import { addCallback } from '../lib/teact/teactn';
import { getActions, getGlobal } from '../global';

import type { ActionPayloads, GlobalState } from '../global/types';
import { type ApiSessionData } from '../api/types';

import { getCurrentTabId } from './establishMultitabRole';

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

type CurrentState = Pick<GlobalState, 'authState' | 'currentUserId'> & {
  messageList?: GlobalState['byTabId'][number]['messageLists'][number];
};
const current: CurrentState = {
  currentUserId: undefined,
  authState: undefined,
  messageList: undefined,
};

addCallback(() => {
  const global = getGlobal();
  if (global.authState !== current.authState) {
    current.authState = global.authState;
    sendMessage({
      type: 'authState',
      state: current.authState,
    });
  }

  const messageLists = global.byTabId[getCurrentTabId()]?.messageLists;
  const currentList = messageLists?.[messageLists.length - 1];

  if (currentList !== current.messageList) {
    current.messageList = currentList;
    sendMessage({
      type: 'chatOpened',
      chat: currentList,
    });
  }

  const unreadCount = Object.values(global.chats.byId).reduce((acc, chat) => {
    return acc + (chat.unreadCount || 0);
  }, 0);

  sendMessage({
    type: 'unreadCount',
    count: unreadCount,
  });
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
  if (![
    'http://localhost:3000',
    'https://hints-crm.web.app',
    'https://app.crmchat.ai',
  ].includes(event.origin)) {
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

export function updateSessionInCrmChat(sessionData: ApiSessionData) {
  sendMessage({
    type: 'updateSession',
    sessionData,
  });
}

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
