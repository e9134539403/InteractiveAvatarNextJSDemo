import {
  AvatarQuality,
  StreamingEvents,
  VoiceChatTransport,
  VoiceEmotion,
  StartAvatarRequest,
  STTProvider,
  ElevenLabsModel,
} from "@heygen/streaming-avatar";
import { useEffect, useRef, useState } from "react";
import { useMemoizedFn, useUnmount } from "ahooks";

import { Button } from "./Button";
import { AvatarConfig } from "./AvatarConfig";
import { AvatarVideo } from "./AvatarSession/AvatarVideo";
import { useStreamingAvatarSession } from "./logic/useStreamingAvatarSession";
import { AvatarControls } from "./AvatarSession/AvatarControls";
import { useVoiceChat } from "./logic/useVoiceChat";
import { StreamingAvatarProvider, StreamingAvatarSessionState } from "./logic";
import { LoadingIcon } from "./Icons";
import { MessageHistory } from "./AvatarSession/MessageHistory";

import { AVATARS } from "@/app/lib/constants";

const DEFAULT_CONFIG: StartAvatarRequest = {
  quality: AvatarQuality.Low,
  avatarName: AVATARS[0].avatar_id,
  knowledgeId: undefined,
  voice: {
    rate: 1.5,
    emotion: VoiceEmotion.EXCITED,
    model: ElevenLabsModel.eleven_flash_v2_5,
  },
  language: "en",
  voiceChatTransport: VoiceChatTransport.WEBSOCKET,
  sttSettings: {
    provider: STTProvider.DEEPGRAM,
  },
};

function InteractiveAvatar() {
  const { initAvatar, startAvatar, stopAvatar, sessionState, stream } =
    useStreamingAvatarSession();
  const { startVoiceChat } = useVoiceChat();

  const [config, setConfig] = useState<StartAvatarRequest>(DEFAULT_CONFIG);

  // ---- refs / state for robust reconnects ----
  const mediaStream = useRef<HTMLVideoElement>(null);
  const avatarRef = useRef<any>(null);
  const keepAliveIntervalRef = useRef<number | null>(null);
  const isVoiceChatRef = useRef<boolean>(false);

  // актуальный config вне замыканий
  const configRef = useRef<StartAvatarRequest>(DEFAULT_CONFIG);
  useEffect(() => {
    configRef.current = config;
  }, [config]);

  // реконнекты/грейс-окна
  const reconnectRef = useRef<{
    attempts: number;
    timer: number | undefined;
    graceTimer: number | undefined;
  }>({ attempts: 0, timer: undefined, graceTimer: undefined });

  // single-flight замки
  const startInFlight = useRef(false);
  const stopInFlight = useRef(false);
  const resetInFlight = useRef(false);

  // пауза/возобновление голосового пайплайна
  const voicePausedRef = useRef(false);
  const voiceStartInFlight = useRef(false);

  // «здоровая» сессия
  const isHealthy = useMemoizedFn(
    () => sessionState === StreamingAvatarSessionState.CONNECTED
  );

  async function fetchAccessToken() {
    try {
      const response = await fetch("/api/get-access-token", { method: "POST" });
      const token = await response.text();
      console.log("Access Token:", token);
      return token;
    } catch (error) {
      console.error("Error fetching access token:", error);
      throw error;
    }
  }
