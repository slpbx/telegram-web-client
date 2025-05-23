import { useMemo } from '../lib/teact/teact';

import type {
  ApiAudio, ApiChat, ApiMessage, ApiPeer, ApiVoice,
  MediaContent,
} from '../api/types';

import {
  getAudioHasCover, getChatAvatarHash, getChatTitle, getMediaHash, getMessageContent,
} from '../global/helpers';
import { getPeerTitle } from '../global/helpers/peers';
import { resizeImage, scaleImage } from '../util/imageResize';
import { buildMediaMetadata } from '../util/mediaSession';
import { AVATAR_FULL_DIMENSIONS } from '../components/common/helpers/mediaDimensions';
import useAsync from './useAsync';
import useMedia from './useMedia';
import useOldLang from './useOldLang';

import telegramLogoPath from '../assets/telegram-logo-filled.svg';

const LOGO_DIMENSIONS = { width: 200, height: 200 };
const MINIMAL_SIZE = 115; // spec says 100, but on Chrome 93 it's not showing

// TODO Add support for video in future
const useMessageMediaMetadata = (
  message?: ApiMessage, sender?: ApiPeer, chat?: ApiChat,
): MediaMetadata | undefined => {
  const lang = useOldLang();

  const { audio, voice } = message ? getMessageContent(message) : {} satisfies MediaContent;
  const title = audio ? (audio.title || audio.fileName) : voice ? 'Voice message' : '';
  const artist = audio?.performer || (sender && getPeerTitle(lang, sender));
  const album = (chat && getChatTitle(lang, chat)) || 'Telegram';

  const audioCoverHash = (audio && getAudioHasCover(audio) && getMediaHash(audio, 'pictogram'));
  const avatarHash = sender && getChatAvatarHash(sender, 'big');
  const hash = (audio && audioCoverHash) || (voice && avatarHash);
  const media = useMedia(hash);

  const size = useMemo(() => {
    return getCoverSize(audio, voice, media);
  }, [audio, media, voice]);
  const { result: url } = useAsync(() => (
    makeGoodArtwork(media, size)
  ), [media, size], telegramLogoPath);
  return useMemo(() => {
    return buildMediaMetadata({
      title,
      artist,
      album,
      artwork: [{ src: url }],
    });
  }, [album, artist, title, url]);
};

function makeGoodArtwork(url?: string, size?: { width: number; height: number }): Promise<string> {
  if (!url) return Promise.resolve(telegramLogoPath);
  if (!size) return resizeImage(url, MINIMAL_SIZE, MINIMAL_SIZE);
  const min = Math.min(size.width, size.height);
  if (min < MINIMAL_SIZE) {
    const ratio = MINIMAL_SIZE / min;
    return scaleImage(url, ratio);
  }
  return Promise.resolve(url);
}

function getCoverSize(audio?: ApiAudio, voice?: ApiVoice, url?: string) {
  if (!url) return LOGO_DIMENSIONS;
  if (audio) {
    if (!audio.thumbnailSizes?.length) return undefined;
    const preferred = audio.thumbnailSizes.find((size) => size.type === 'm');
    return preferred || audio.thumbnailSizes[0]; // Sometimes `m` is not present
  }

  if (voice) {
    return AVATAR_FULL_DIMENSIONS;
  }

  return undefined;
}

export default useMessageMediaMetadata;
