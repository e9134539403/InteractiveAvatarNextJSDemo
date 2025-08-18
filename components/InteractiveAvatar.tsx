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

  // Пауза голоса на время разрыва (чтобы не слать в закрытый сокет)
  const pauseVoicePump = useMemoizedFn(() => {
    voicePausedRef.current = true;
    // при необходимости можно вызывать stop в useVoiceChat, если реализован
  });

  // Возобновить голос после восстановления
  const maybeResumeVoice = useMemoizedFn(async () => {
    if (!isHealthy() || !isVoiceChatRef.current) return;
    if (voiceStartInFlight.current) return;
    voiceStartInFlight.current = true;
    try {
      await startVoiceChat();
      voicePausedRef.current = false;
      console.info("🟢 voice resumed");
    } catch (e) {
      console.warn("resume voice failed", e);
    } finally {
      voiceStartInFlight.current = false;
    }
  });

  // Отмена всех запланированных жёстких рестартов
  const cancelPendingHardReset = useMemoizedFn(() => {
    if (reconnectRef.current.timer) {
      clearTimeout(reconnectRef.current.timer);
      reconnectRef.current.timer = undefined;
    }
    if (reconnectRef.current.graceTimer) {
      clearTimeout(reconnectRef.current.graceTimer);
      reconnectRef.current.graceTimer = undefined;
    }
    reconnectRef.current.attempts = 0;
    console.info("🟦 Reconnect succeeded → cancel pending hard reset");
  });

  // Безопасные start/stop с замками
  const safeStop = useMemoizedFn(async () => {
    if (stopInFlight.current) return;
    stopInFlight.current = true;
    try {
      if (sessionState === StreamingAvatarSessionState.CONNECTED) {
        await stopAvatar().catch(() => {}); // 401/ошибки глушим
      }
    } finally {
      stopInFlight.current = false;
    }
  });

  const safeStart = useMemoizedFn(async (cfg: StartAvatarRequest) => {
    if (startInFlight.current) return;
    startInFlight.current = true;
    try {
      await startAvatar(cfg);
    } finally {
      startInFlight.current = false;
    }
  });

  // HARD reset как запасной вариант с бэкоффом
  const hardResetWithBackoff = useMemoizedFn(async (reason: string) => {
    if (resetInFlight.current || reconnectRef.current.timer) return;
    resetInFlight.current = true;

    const attempt = reconnectRef.current.attempts;
    const delay =
      Math.min(20000, 1000 * Math.pow(2, attempt)) +
      Math.floor(Math.random() * 500);

    reconnectRef.current.attempts = attempt + 1;

    reconnectRef.current.timer = window.setTimeout(async () => {
      reconnectRef.current.timer = undefined;
      try {
        console.warn(`🔁 HARD reset: ${reason}, attempt=${attempt}`);
        await safeStop();
        await new Promise((r) => setTimeout(r, 1200)); // закрыться серверу

        const token = await fetchAccessToken();
        const newAvatar = initAvatar(token);
        avatarRef.current = newAvatar;

        setupAvatarEventHandlers(newAvatar);

        const cfg: StartAvatarRequest = {
          ...configRef.current,
          activityIdleTimeout: 3600, // максимум 1 час
        };
        await safeStart(cfg);

        await maybeResumeVoice();
        reconnectRef.current.attempts = 0;
        console.info("✅ HARD reset done");
      } catch (e) {
        console.error("hard reset failed, will retry", e);
        hardResetWithBackoff("retry after fail");
      } finally {
        resetInFlight.current = false;
      }
    }, delay);
  });

  // Навешивание обработчиков на avatar
  const setupAvatarEventHandlers = useMemoizedFn((avatar: any) => {
    if (!avatar) return;

    avatar.on(StreamingEvents.AVATAR_START_TALKING, (e: any) => {
      console.log("Avatar started talking", e);
    });
    avatar.on(StreamingEvents.AVATAR_STOP_TALKING, (e: any) => {
      console.log("Avatar stopped talking", e);
    });

    avatar.on(StreamingEvents.STREAM_READY, (event: any) => {
      console.log(">>>>> Stream ready:", event.detail);
      cancelPendingHardReset();
      maybeResumeVoice();
    });

    avatar.on(StreamingEvents.USER_START, (event: any) => {
      console.log(">>>>> User started talking:", event);
    });
    avatar.on(StreamingEvents.USER_STOP, (event: any) => {
      console.log(">>>>> User stopped talking:", event);
    });
    avatar.on(StreamingEvents.USER_END_MESSAGE, (event: any) => {
      console.log(">>>>> User end message:", event);
    });
    avatar.on(StreamingEvents.USER_TALKING_MESSAGE, (event: any) => {
      console.log(">>>>> User talking message:", event);
    });
    avatar.on(StreamingEvents.AVATAR_TALKING_MESSAGE, (event: any) => {
      console.log(">>>>> Avatar talking message:", event);
    });
    avatar.on(StreamingEvents.AVATAR_END_MESSAGE, (event: any) => {
      console.log(">>>>> Avatar end message:", event);
    });

    // Короткое «грейс-окно»: даём LiveKit шанс авто-восстановиться
    avatar.on(StreamingEvents.STREAM_DISCONNECTED, async () => {
      console.warn(
        "⚠️ STREAM_DISCONNECTED → pause voice & grace window for auto-reconnect"
      );
      pauseVoicePump();

      if (!reconnectRef.current.graceTimer) {
        reconnectRef.current.graceTimer = window.setTimeout(() => {
          reconnectRef.current.graceTimer = undefined;
          hardResetWithBackoff("grace window elapsed");
        }, 4000);
      }
    });
  });

  const startSessionV2 = useMemoizedFn(async (isVoiceChat: boolean) => {
    try {
      isVoiceChatRef.current = isVoiceChat;

      const newToken = await fetchAccessToken();
      const avatar = initAvatar(newToken);
      avatarRef.current = avatar;

      setupAvatarEventHandlers(avatar);

      const extendedConfig: StartAvatarRequest = {
        ...configRef.current,
        activityIdleTimeout: 3600, // 1 час максимум
      };

      await safeStart(extendedConfig);

      // keepAlive — только когда сессия «здоровая»
      if (keepAliveIntervalRef.current == null) {
        keepAliveIntervalRef.current = window.setInterval(() => {
          if (isHealthy() && avatarRef.current?.keepAlive) {
            avatarRef.current.keepAlive();
          }
        }, 300000); // 5 мин
      }

      if (isVoiceChat && isHealthy()) {
        await startVoiceChat();
        voicePausedRef.current = false;
      }
    } catch (error) {
      console.error("Error starting avatar session:", error);
    }
  });

  // При размонтировании — чистим всё
  useUnmount(() => {
    if (keepAliveIntervalRef.current != null) {
      clearInterval(keepAliveIntervalRef.current);
      keepAliveIntervalRef.current = null;
    }
    if (reconnectRef.current.timer) {
      clearTimeout(reconnectRef.current.timer);
      reconnectRef.current.timer = undefined;
    }
    if (reconnectRef.current.graceTimer) {
      clearTimeout(reconnectRef.current.graceTimer);
      reconnectRef.current.graceTimer = undefined;
    }
    reconnectRef.current.attempts = 0;
    avatarRef.current = null;
    stopAvatar();
  });

  // Подключаем видеопоток
  useEffect(() => {
    if (stream && mediaStream.current) {
      mediaStream.current.srcObject = stream as any;
      mediaStream.current.onloadedmetadata = () => {
        mediaStream.current!.play();
      };
      // если видео реально заиграло — отменяем запланированный рестарт
      mediaStream.current.onplaying = () => {
        cancelPendingHardReset();
      };
    }
  }, [stream, cancelPendingHardReset]);

  // Следим за удалённым видеотреком: «залип» → грейс и, если не ожил, hard-reset
  useEffect(() => {
    const videoEl = mediaStream.current;
    if (!videoEl || !stream) return;

    const tracks = (stream as MediaStream).getVideoTracks?.() || [];
    const track = tracks[0];

    const onTrackProblem = () => {
      console.warn(
        "🎞️ remote video track problem (mute/ended) → grace & maybe hard reset"
      );
      pauseVoicePump();
      if (!reconnectRef.current.graceTimer) {
        reconnectRef.current.graceTimer = window.setTimeout(() => {
          reconnectRef.current.graceTimer = undefined;
          hardResetWithBackoff("remote video track stuck");
        }, 3000);
      }
    };

    track?.addEventListener?.("ended", onTrackProblem);
    track?.addEventListener?.("mute", onTrackProblem);

    const onPlaying = () => cancelPendingHardReset();
    videoEl.addEventListener("playing", onPlaying);

    return () => {
      track?.removeEventListener?.("ended", onTrackProblem);
      track?.removeEventListener?.("mute", onTrackProblem);
      videoEl.removeEventListener("playing", onPlaying);
    };
  }, [stream, cancelPendingHardReset, hardResetWithBackoff, pauseVoicePump]);

  return (
    <div className="w-full flex flex-col gap-4">
      <div className="flex flex-col rounded-xl bg-zinc-900 overflow-hidden">
        <div className="relative w-full aspect-video overflow-hidden flex flex-col items-center justify-center">
          {sessionState !== StreamingAvatarSessionState.INACTIVE ? (
            <AvatarVideo ref={mediaStream} />
          ) : (
            <AvatarConfig config={config} onConfigChange={setConfig} />
          )}
        </div>
        <div className="flex flex-col gap-3 items-center justify-center p-4 border-t border-zinc-700 w-full">
          {sessionState === StreamingAvatarSessionState.CONNECTED ? (
            <AvatarControls />
          ) : sessionState === StreamingAvatarSessionState.INACTIVE ? (
            <div className="flex flex-row gap-4">
              <Button onClick={() => startSessionV2(true)}>Start Voice Chat</Button>
              <Button onClick={() => startSessionV2(false)}>Start Text Chat</Button>
            </div>
          ) : (
            <LoadingIcon />
          )}
        </div>
      </div>
      {sessionState === StreamingAvatarSessionState.CONNECTED && <MessageHistory />}
    </div>
  );
}

export default function InteractiveAvatarWrapper() {
  return (
    <StreamingAvatarProvider basePath={process.env.NEXT_PUBLIC_BASE_API_URL}>
      <InteractiveAvatar />
    </StreamingAvatarProvider>
  );
}
