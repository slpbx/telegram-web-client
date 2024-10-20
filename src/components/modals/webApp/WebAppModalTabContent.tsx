import type { FC } from '../../../lib/teact/teact';
import React, {
  memo, useEffect,
  useRef, useState,
} from '../../../lib/teact/teact';
import { getActions, withGlobal } from '../../../global';

import type { ApiAttachBot, ApiChat, ApiUser } from '../../../api/types';
import type { TabState, WebApp } from '../../../global/types';
import type { ThemeKey } from '../../../types';
import type { PopupOptions, WebAppInboundEvent, WebAppOutboundEvent } from '../../../types/webapp';

import { TME_LINK_PREFIX } from '../../../config';
import { convertToApiChatType } from '../../../global/helpers';
import { getWebAppKey } from '../../../global/helpers/bots';
import {
  selectCurrentChat, selectTabState, selectTheme, selectUser,
} from '../../../global/selectors';
import buildClassName from '../../../util/buildClassName';
import buildStyle from '../../../util/buildStyle';
import { extractCurrentThemeParams, validateHexColor } from '../../../util/themeStyle';
import { callApi } from '../../../api/gramjs';
import { REM } from '../../common/helpers/mediaDimensions';
import renderText from '../../common/helpers/renderText';

import useFlag from '../../../hooks/useFlag';
import useLastCallback from '../../../hooks/useLastCallback';
import useOldLang from '../../../hooks/useOldLang';
import usePreviousDeprecated from '../../../hooks/usePreviousDeprecated';
import useSyncEffect from '../../../hooks/useSyncEffect';
import usePopupLimit from './hooks/usePopupLimit';
import useWebAppFrame from './hooks/useWebAppFrame';

import Button from '../../ui/Button';
import ConfirmDialog from '../../ui/ConfirmDialog';
import Modal from '../../ui/Modal';
import Spinner from '../../ui/Spinner';

import styles from './WebAppModalTabContent.module.scss';

type WebAppButton = {
  isVisible: boolean;
  isActive: boolean;
  text: string;
  color: string;
  textColor: string;
  isProgressVisible: boolean;
};

export type OwnProps = {
  modal?: TabState['webApps'];
  webApp?: WebApp;
  registerSendEventCallback: (callback: (event: WebAppOutboundEvent) => void) => void;
  registerReloadFrameCallback: (callback: (url: string) => void) => void;
  isDragging?: boolean;
  frameSize?: { width: number; height: number };
  isMultiTabSupported? : boolean;
};

type StateProps = {
  chat?: ApiChat;
  bot?: ApiUser;
  attachBot?: ApiAttachBot;
  theme?: ThemeKey;
  isPaymentModalOpen?: boolean;
  paymentStatus?: TabState['payment']['status'];
  isMaximizedState: boolean;
};

const NBSP = '\u00A0';

const MAIN_BUTTON_ANIMATION_TIME = 250;
const ANIMATION_WAIT = 400;
const POPUP_SEQUENTIAL_LIMIT = 3;
const POPUP_RESET_DELAY = 2000; // 2s
const SANDBOX_ATTRIBUTES = [
  'allow-scripts',
  'allow-same-origin',
  'allow-popups',
  'allow-forms',
  'allow-modals',
  'allow-storage-access-by-user-activation',
].join(' ');

const DEFAULT_BUTTON_TEXT: Record<string, string> = {
  ok: 'OK',
  cancel: 'Cancel',
  close: 'Close',
};

const WebAppModalTabContent: FC<OwnProps & StateProps> = ({
  modal,
  webApp,
  bot,
  theme,
  isPaymentModalOpen,
  paymentStatus,
  registerSendEventCallback,
  registerReloadFrameCallback,
  isDragging,
  isMaximizedState,
  frameSize,
  isMultiTabSupported,
}) => {
  const {
    closeActiveWebApp,
    sendWebViewData,
    toggleAttachBot,
    openTelegramLink,
    setWebAppPaymentSlug,
    switchBotInline,
    sharePhoneWithBot,
    updateWebApp,
  } = getActions();
  const [mainButton, setMainButton] = useState<WebAppButton | undefined>();

  const [isLoaded, markLoaded, markUnloaded] = useFlag(false);

  const [popupParameters, setPopupParameters] = useState<PopupOptions | undefined>();
  const [isRequestingPhone, setIsRequestingPhone] = useState(false);
  const [isRequestingWriteAccess, setIsRequestingWriteAccess] = useState(false);
  const {
    unlockPopupsAt, handlePopupOpened, handlePopupClosed,
  } = usePopupLimit(POPUP_SEQUENTIAL_LIMIT, POPUP_RESET_DELAY);

  const activeWebApp = modal?.activeWebApp;
  const {
    url, buttonText, headerColor, serverHeaderColorKey, serverHeaderColor,
  } = webApp || {};
  const isCloseModalOpen = Boolean(webApp?.isCloseModalOpen);
  const isRemoveModalOpen = Boolean(webApp?.isRemoveModalOpen);

  const webAppKey = webApp && getWebAppKey(webApp);
  const activeWebAppKey = activeWebApp && getWebAppKey(activeWebApp);

  const isActive = (activeWebApp && webApp) && activeWebAppKey === webAppKey;

  const updateCurrentWebApp = useLastCallback((updatedPartialWebApp: Partial<WebApp>) => {
    if (!webApp) return;
    const updatedWebApp = {
      ...webApp,
      ...updatedPartialWebApp,
    };
    webApp = updatedWebApp;
    updateWebApp({ webApp: updatedWebApp });
  });

  useEffect(() => {
    const themeParams = extractCurrentThemeParams();
    updateCurrentWebApp({ headerColor: themeParams.bg_color, backgroundColor: themeParams.bg_color });
  }, []);

  // eslint-disable-next-line no-null/no-null
  const frameRef = useRef<HTMLIFrameElement>(null);

  const lang = useOldLang();
  const isOpen = modal?.isModalOpen || false;
  const isSimple = Boolean(buttonText);

  const {
    reloadFrame, sendEvent, sendViewport, sendTheme,
  } = useWebAppFrame(frameRef, isOpen, isSimple, handleEvent, webApp, markLoaded);

  useEffect(() => {
    if (isActive) registerSendEventCallback(sendEvent);
  }, [sendEvent, registerSendEventCallback, isActive]);

  useEffect(() => {
    if (isActive) registerReloadFrameCallback(reloadFrame);
  }, [reloadFrame, registerReloadFrameCallback, isActive]);

  const shouldShowMainButton = mainButton?.isVisible && mainButton.text.trim().length > 0;

  const handleHideCloseModal = useLastCallback(() => {
    updateCurrentWebApp({ isCloseModalOpen: false });
  });
  const handleConfirmCloseModal = useLastCallback(() => {
    updateCurrentWebApp({ shouldConfirmClosing: false, isCloseModalOpen: false });
    setTimeout(() => {
      closeActiveWebApp();
    }, ANIMATION_WAIT);
  });

  const handleHideRemoveModal = useLastCallback(() => {
    updateCurrentWebApp({ isRemoveModalOpen: false });
  });

  const handleMainButtonClick = useLastCallback(() => {
    sendEvent({
      eventType: 'main_button_pressed',
    });
  });

  const handleAppPopupClose = useLastCallback((buttonId?: string) => {
    setPopupParameters(undefined);
    handlePopupClosed();
    sendEvent({
      eventType: 'popup_closed',
      eventData: {
        button_id: buttonId,
      },
    });
  });

  const handleAppPopupModalClose = useLastCallback(() => {
    handleAppPopupClose();
  });

  const calculateHeaderColor = useLastCallback(
    (serverColorKey? : 'bg_color' | 'secondary_bg_color', serverColor? : string) => {
      if (serverColorKey) {
        const themeParams = extractCurrentThemeParams();
        const key = serverColorKey;
        const newColor = themeParams[key];
        const color = validateHexColor(newColor) ? newColor : headerColor;
        updateCurrentWebApp({ headerColor: color, serverHeaderColorKey: key });
      }

      if (serverColor) {
        const color = validateHexColor(serverColor) ? serverColor : headerColor;
        updateCurrentWebApp({ headerColor: color, serverHeaderColor: serverColor });
      }
    },
  );

  const updateHeaderColor = useLastCallback(
    () => {
      calculateHeaderColor(serverHeaderColorKey, serverHeaderColor);
    },
  );

  const sendThemeCallback = useLastCallback(() => {
    sendTheme();
    updateHeaderColor();
  });

  // Notify view that theme changed
  useSyncEffect(() => {
    setTimeout(() => {
      sendThemeCallback();
    }, ANIMATION_WAIT);
  }, [theme]);

  // Notify view that height changed
  useSyncEffect(() => {
    setTimeout(() => {
      sendViewport();
    }, ANIMATION_WAIT);
  }, [mainButton?.isVisible, sendViewport]);

  useSyncEffect(([prevIsPaymentModalOpen]) => {
    if (isPaymentModalOpen === prevIsPaymentModalOpen) return;
    if (webApp?.slug && !isPaymentModalOpen && paymentStatus) {
      sendEvent({
        eventType: 'invoice_closed',
        eventData: {
          slug: webApp.slug,
          status: paymentStatus,
        },
      });
      setWebAppPaymentSlug({
        slug: undefined,
      });
    }
  }, [isPaymentModalOpen, paymentStatus, sendEvent, webApp?.slug]);

  const handleRemoveAttachBot = useLastCallback(() => {
    toggleAttachBot({
      botId: bot!.id,
      isEnabled: false,
    });
    closeActiveWebApp();
  });

  const handleRejectPhone = useLastCallback(() => {
    setIsRequestingPhone(false);
    handlePopupClosed();
    sendEvent({
      eventType: 'phone_requested',
      eventData: {
        status: 'cancelled',
      },
    });
  });

  const handleAcceptPhone = useLastCallback(() => {
    sharePhoneWithBot({ botId: bot!.id });
    setIsRequestingPhone(false);
    handlePopupClosed();
    sendEvent({
      eventType: 'phone_requested',
      eventData: {
        status: 'sent',
      },
    });
  });

  const handleRejectWriteAccess = useLastCallback(() => {
    sendEvent({
      eventType: 'write_access_requested',
      eventData: {
        status: 'cancelled',
      },
    });
    setIsRequestingWriteAccess(false);
    handlePopupClosed();
  });

  const handleAcceptWriteAccess = useLastCallback(async () => {
    const result = await callApi('allowBotSendMessages', { bot: bot! });
    if (!result) {
      handleRejectWriteAccess();
      return;
    }

    sendEvent({
      eventType: 'write_access_requested',
      eventData: {
        status: 'allowed',
      },
    });
    setIsRequestingWriteAccess(false);
    handlePopupClosed();
  });

  async function handleRequestWriteAccess() {
    const canWrite = await callApi('fetchBotCanSendMessage', {
      bot: bot!,
    });

    if (canWrite) {
      sendEvent({
        eventType: 'write_access_requested',
        eventData: {
          status: 'allowed',
        },
      });
    }

    setIsRequestingWriteAccess(!canWrite);
  }

  async function handleInvokeCustomMethod(requestId: string, method: string, parameters: string) {
    const result = await callApi('invokeWebViewCustomMethod', {
      bot: bot!,
      customMethod: method,
      parameters,
    });

    sendEvent({
      eventType: 'custom_method_invoked',
      eventData: {
        req_id: requestId,
        ...result,
      },
    });
  }

  useEffect(() => {
    if (!isOpen) {
      setPopupParameters(undefined);
      setIsRequestingPhone(false);
      setIsRequestingWriteAccess(false);
      setMainButton(undefined);
      updateCurrentWebApp({
        isSettingsButtonVisible: false,
        shouldConfirmClosing: false,
        isBackButtonVisible: false,
        isCloseModalOpen: false,
        isRemoveModalOpen: false,
      });
      markUnloaded();
    }
  }, [isOpen]);

  function handleEvent(event: WebAppInboundEvent) {
    const { eventType, eventData } = event;
    if (eventType === 'web_app_open_tg_link' && !isPaymentModalOpen) {
      const linkUrl = TME_LINK_PREFIX + eventData.path_full;
      openTelegramLink({ url: linkUrl });
      closeActiveWebApp();
    }

    if (eventType === 'web_app_setup_back_button') {
      updateCurrentWebApp({ isBackButtonVisible: eventData.is_visible });
    }

    if (eventType === 'web_app_setup_settings_button') {
      updateCurrentWebApp({ isSettingsButtonVisible: eventData.is_visible });
    }

    if (eventType === 'web_app_set_background_color') {
      const themeParams = extractCurrentThemeParams();
      const color = validateHexColor(eventData.color) ? eventData.color : themeParams.bg_color;
      updateCurrentWebApp({ backgroundColor: color });
    }

    if (eventType === 'web_app_set_header_color') {
      calculateHeaderColor(eventData.color_key, eventData.color);
    }

    if (eventType === 'web_app_data_send') {
      closeActiveWebApp();
      sendWebViewData({
        bot: bot!,
        buttonText: buttonText!,
        data: eventData.data,
      });
    }

    if (eventType === 'web_app_setup_main_button') {
      const themeParams = extractCurrentThemeParams();
      const color = validateHexColor(eventData.color) ? eventData.color : themeParams.button_color;
      const textColor = validateHexColor(eventData.text_color) ? eventData.text_color : themeParams.text_color;
      setMainButton({
        isVisible: eventData.is_visible && Boolean(eventData.text?.trim().length),
        isActive: eventData.is_active,
        text: eventData.text || '',
        color,
        textColor,
        isProgressVisible: eventData.is_progress_visible,
      });
    }

    if (eventType === 'web_app_setup_closing_behavior') {
      updateCurrentWebApp({ shouldConfirmClosing: true });
    }

    if (eventType === 'web_app_open_popup') {
      if (popupParameters || !eventData.message.trim().length || !eventData.buttons?.length
      || eventData.buttons.length > 3 || isRequestingPhone || isRequestingWriteAccess
      || unlockPopupsAt > Date.now()) {
        handleAppPopupClose(undefined);
        return;
      }

      setPopupParameters(eventData);
      handlePopupOpened();
    }

    if (eventType === 'web_app_switch_inline_query') {
      const filter = eventData.chat_types?.map(convertToApiChatType).filter(Boolean);
      const isSamePeer = !filter?.length;

      switchBotInline({
        botId: bot!.id,
        query: eventData.query,
        filter,
        isSamePeer,
      });

      closeActiveWebApp();
    }

    if (eventType === 'web_app_request_phone') {
      if (popupParameters || isRequestingWriteAccess || unlockPopupsAt > Date.now()) {
        handleRejectPhone();
        return;
      }

      setIsRequestingPhone(true);
      handlePopupOpened();
    }

    if (eventType === 'web_app_request_write_access') {
      if (popupParameters || isRequestingPhone || unlockPopupsAt > Date.now()) {
        handleRejectWriteAccess();
        return;
      }

      handleRequestWriteAccess();
      handlePopupOpened();
    }

    if (eventType === 'web_app_invoke_custom_method') {
      const { method, params, req_id: requestId } = eventData;
      handleInvokeCustomMethod(requestId, method, JSON.stringify(params));
    }
  }

  const prevMainButtonColor = usePreviousDeprecated(mainButton?.color, true);
  const prevMainButtonTextColor = usePreviousDeprecated(mainButton?.textColor, true);
  const prevMainButtonIsActive = usePreviousDeprecated(mainButton && Boolean(mainButton.isActive), true);
  const prevMainButtonText = usePreviousDeprecated(mainButton?.text, true);

  const mainButtonCurrentColor = mainButton?.color || prevMainButtonColor;
  const mainButtonCurrentTextColor = mainButton?.textColor || prevMainButtonTextColor;
  const mainButtonCurrentIsActive = mainButton?.isActive !== undefined ? mainButton.isActive : prevMainButtonIsActive;
  const mainButtonCurrentText = mainButton?.text || prevMainButtonText;

  const [shouldDecreaseWebFrameSize, setShouldDecreaseWebFrameSize] = useState(false);
  const [shouldHideButton, setShouldHideButton] = useState(true);

  const buttonChangeTimeout = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    if (buttonChangeTimeout.current) clearTimeout(buttonChangeTimeout.current);
    if (!shouldShowMainButton) {
      setShouldDecreaseWebFrameSize(false);
      buttonChangeTimeout.current = setTimeout(() => {
        setShouldHideButton(true);
      }, MAIN_BUTTON_ANIMATION_TIME);
    } else {
      setShouldHideButton(false);
      buttonChangeTimeout.current = setTimeout(() => {
        setShouldDecreaseWebFrameSize(true);
      }, MAIN_BUTTON_ANIMATION_TIME);
    }
  }, [setShouldDecreaseWebFrameSize, shouldShowMainButton]);

  const frameWidth = frameSize?.width || 0;
  let frameHeight = frameSize?.height || 0;
  if (shouldDecreaseWebFrameSize) { frameHeight -= 3.5 * REM; }
  const frameStyle = buildStyle(
    `left: ${0}px;`,
    `top: ${0}px;`,
    `width: ${frameWidth}px;`,
    `height: ${frameHeight}px;`,
    isDragging ? 'pointer-events: none;' : '',
  );

  return (
    <div
      className={buildClassName(
        styles.root,
        !isActive && styles.hidden,
        isMultiTabSupported && styles.multiTab,
      )}
    >
      {isMaximizedState && <Spinner className={buildClassName(styles.loadingSpinner, isLoaded && styles.hide)} />}
      <iframe
        className={buildClassName(
          styles.frame,
          shouldDecreaseWebFrameSize && styles.withButton,
          !isLoaded && styles.hide,
        )}
        style={frameSize ? frameStyle : undefined}
        src={url}
        title={`${bot?.firstName} Web App`}
        sandbox={SANDBOX_ATTRIBUTES}
        allow="camera; microphone; geolocation;"
        allowFullScreen
        ref={frameRef}
      />
      {isMaximizedState && (
        <Button
          className={buildClassName(
            styles.mainButton,
            shouldShowMainButton && styles.visible,
            shouldHideButton && styles.hidden,
          )}
          style={`background-color: ${mainButtonCurrentColor}; color: ${mainButtonCurrentTextColor}`}
          disabled={!mainButtonCurrentIsActive}
          onClick={handleMainButtonClick}
        >
          {mainButtonCurrentText}
          {mainButton?.isProgressVisible && <Spinner className={styles.mainButtonSpinner} color="white" />}
        </Button>
      ) }
      <ConfirmDialog
        isOpen={isRequestingPhone}
        onClose={handleRejectPhone}
        title={lang('ShareYouPhoneNumberTitle')}
        text={lang('AreYouSureShareMyContactInfoBot')}
        confirmHandler={handleAcceptPhone}
        confirmLabel={lang('ContactShare')}
      />
      <ConfirmDialog
        isOpen={isRequestingWriteAccess}
        onClose={handleRejectWriteAccess}
        title={lang('lng_bot_allow_write_title')}
        text={lang('lng_bot_allow_write')}
        confirmHandler={handleAcceptWriteAccess}
        confirmLabel={lang('lng_bot_allow_write_confirm')}
      />
      {popupParameters && (
        <Modal
          isOpen={Boolean(popupParameters)}
          title={popupParameters.title || NBSP}
          onClose={handleAppPopupModalClose}
          hasCloseButton
          className={
            buildClassName(styles.webAppPopup, !popupParameters.title?.trim().length && styles.withoutTitle)
          }
        >
          {popupParameters.message}
          <div className="dialog-buttons mt-2">
            {popupParameters.buttons.map((button) => (
              <Button
                key={button.id || button.type}
                className="confirm-dialog-button"
                color={button.type === 'destructive' ? 'danger' : 'primary'}
                isText
                size="smaller"
                // eslint-disable-next-line react/jsx-no-bind
                onClick={() => handleAppPopupClose(button.id)}
              >
                {button.text || lang(DEFAULT_BUTTON_TEXT[button.type])}
              </Button>
            ))}
          </div>
        </Modal>
      )}

      <ConfirmDialog
        isOpen={isCloseModalOpen}
        onClose={handleHideCloseModal}
        title={lang('lng_bot_close_warning_title')}
        text={lang('lng_bot_close_warning')}
        confirmHandler={handleConfirmCloseModal}
        confirmIsDestructive
        confirmLabel={lang('lng_bot_close_warning_sure')}
      />
      <ConfirmDialog
        isOpen={isRemoveModalOpen}
        onClose={handleHideRemoveModal}
        title={lang('BotRemoveFromMenuTitle')}
        textParts={renderText(lang('BotRemoveFromMenu', bot?.firstName), ['simple_markdown'])}
        confirmHandler={handleRemoveAttachBot}
        confirmIsDestructive
      />
    </div>
  );
};

export default memo(withGlobal<OwnProps>(
  (global, { modal }): StateProps => {
    const { botId: activeBotId } = modal?.activeWebApp || {};
    const isMaximizedState = modal?.modalState === 'maximized';

    const attachBot = activeBotId ? global.attachMenu.bots[activeBotId] : undefined;
    const bot = activeBotId ? selectUser(global, activeBotId) : undefined;
    const chat = selectCurrentChat(global);
    const theme = selectTheme(global);
    const { isPaymentModalOpen, status } = selectTabState(global).payment;
    const { isStarPaymentModalOpen } = selectTabState(global);

    return {
      attachBot,
      bot,
      chat,
      theme,
      isPaymentModalOpen: isPaymentModalOpen || isStarPaymentModalOpen,
      paymentStatus: status,
      isMaximizedState,
    };
  },
)(WebAppModalTabContent));