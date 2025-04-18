/* eslint-disable @typescript-eslint/no-unused-vars */
import type { ApiSessionData } from '../api/types';

import {
  DEBUG, IS_SCREEN_LOCKED_CACHE_KEY,
  SESSION_USER_KEY,
} from '../config';
import { requestSessionFromCrmChat, updateSessionInCrmChat } from './crmchat';

const DC_IDS = [1, 2, 3, 4, 5];

export function hasStoredSession() {
  return true;
  /*
  if (checkSessionLocked()) {
    return true;
  }

  const userAuthJson = localStorage.getItem(SESSION_USER_KEY);
  if (!userAuthJson) {
    return false;
  }

  try {
    const userAuth = JSON.parse(userAuthJson);
    return Boolean(userAuth && userAuth.id && userAuth.dcID);
  } catch (err) {
    // Do nothing.
    return false;
  }
  */
}

export function storeSession(sessionData: ApiSessionData, currentUserId?: string) {
  return updateSessionInCrmChat(sessionData);
  /*
  const {
    mainDcId, keys, isTest,
  } = sessionData;

  localStorage.setItem(SESSION_USER_KEY, JSON.stringify({
    dcID: mainDcId,
    id: currentUserId,
    test: isTest,
  }));
  localStorage.setItem('dc', String(mainDcId));
  Object.keys(keys).map(Number).forEach((dcId) => {
    localStorage.setItem(`dc${dcId}_auth_key`, JSON.stringify(keys[dcId]));
  });
}

export function clearStoredSession() {
  // [CRMchat] clearing is unsupported
  return undefined;
  /*
  [
    SESSION_USER_KEY,
    'dc',
    ...DC_IDS.map((dcId) => `dc${dcId}_auth_key`),
    ...DC_IDS.map((dcId) => `dc${dcId}_hash`),
    ...DC_IDS.map((dcId) => `dc${dcId}_server_salt`),
  ].forEach((key) => {
    localStorage.removeItem(key);
  });
  */
}

export function loadStoredSession(): Promise<ApiSessionData | undefined> {
  return requestSessionFromCrmChat();
  /*
  if (!hasStoredSession()) {
    return undefined;
  }

  const userAuth = JSON.parse(localStorage.getItem(SESSION_USER_KEY)!);
  if (!userAuth) {
    return undefined;
  }
  const mainDcId = Number(userAuth.dcID);
  const isTest = userAuth.test;
  const keys: Record<number, string> = {};

  DC_IDS.forEach((dcId) => {
    try {
      const key = localStorage.getItem(`dc${dcId}_auth_key`);
      if (key) {
        keys[dcId] = JSON.parse(key);
      }
    } catch (err) {
      if (DEBUG) {
        // eslint-disable-next-line no-console
        console.warn('Failed to load stored session', err);
      }
      // Do nothing.
    }
  });

  if (!Object.keys(keys).length) return undefined;

  return {
    mainDcId,
    keys,
    isTest,
  };
  */
}

export function importTestSession() {
  const sessionJson = process.env.TEST_SESSION!;
  try {
    const sessionData = JSON.parse(sessionJson) as ApiSessionData & { userId: string };
    storeSession(sessionData, sessionData.userId);
  } catch (err) {
    if (DEBUG) {
      // eslint-disable-next-line no-console
      console.warn('Failed to load test session', err);
    }
  }
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function checkSessionLocked() {
  return localStorage.getItem(IS_SCREEN_LOCKED_CACHE_KEY) === 'true';
}
