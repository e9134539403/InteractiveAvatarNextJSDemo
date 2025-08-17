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

/* ---------------- DEFAULT CONFIG ---------------- */
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
  /* ---------- hooks from SDK wrappers ---------- */
  const { initAvatar, startAvatar, stopAvatar, sessionState, stream } =
    useStreamingAvatarSession();
  const { startVoiceChat } = useVoiceChat();

  /* ---------- CONFIG STATE ---------- */
  const [config, setConfig] = useState<StartAvatarRequest>(DEFAULT_CONFIG);

  /* always-fresh config reference (избегаем устаревшего замыкания) */
  const configRef = useRef(config);
  useEffect(() => {
    configRef.current = config;
  }, [config]);

  /* ---------- REFS / STATE FOR ROBUSTNESS ---------- */
  const mediaStream = useRef<HTMLVideoElement>(null);
  const avatarRef = useRef<any>(null);
  const keepAliveIntervalRef = useRef<number | null>(null);
  const isVoiceChatRef = useRef<boolean>(false);
  const reconnectRef = useRef<{ attempts: number; timer: number | undefined }>({
    attempts: 0,
    timer: undefined,
  });

  /* текущее «здоровое» состояние сессии */
  const isHealthy = useMemoizedFn(
    () => sessionState === StreamingAvatarSessionState.CONNECTED
  );

  /* ---------- TOKEN FETCH ---------- */
  async function fetchAccessToken() {
    try {
      const response = await fetch("/api/get-access-token", {
        method: "POST",
      });
      const token = await response.text();
      console.log("Access Token:", token);
      return token;
    } catch (error) {
      console.error("Error fetching access token:", error);
      throw error;
    }
  }

  /* ---------- SOFT RESTART (перевешиваем треки / STT) ---------- */
  const softRestartTracks = useMemoizedFn(async () => {
    if (!isHealthy()) return;
    try {
      await startVoiceChat();
      console.info("🟢 soft restart tracks done");
    } catch (e: any) {
      console.warn("soft restart warning:", e?.message || e);
    }
  });

  /* ---------- HARD RESET with backoff (полное пересоздание) ---------- */
  const hardResetWithBackoff = useMemoizedFn(async (reason: string) => {
    if (reconnectRef.current.timer) return; // уже запланирован
    const attempt = reconnectRef.current.attempts;
    const delay =
      Math.min(15000, 1000 * Math.pow(2, attempt)) +
      Math.floor(Math.random() * 300);
    reconnectRef.current.attempts = attempt + 1;

    reconnectRef.current.timer = window.setTimeout(async () => {
      reconnectRef.current.timer = undefined;
      try {
        console.warn(`🔁 HARD reset: ${reason}, attempt=${attempt}`);
        await stopAvatar();
        avatarRef.current = null;
        await new Promise((r) => setTimeout(r, 600)); // дать сокетам закрыться

        const token = await fetchAccessToken();
        const newAvatar = initAvatar(token);
        avatarRef.current = newAvatar;
        setupAvatarEventHandlers(newAvatar);

        const extendedConfig: StartAvatarRequest = {
          ...configRef.current,
          activityIdleTimeout: 3600, // максимум 1 час
        };
        await startAvatar(extendedConfig);

        if (isVoiceChatRef.current && isHealthy()) {
          await startVoiceChat();
        }
        reconnectRef.current.attempts = 0; // успех — обнуляем счётчик
        console.info("✅ HARD reset done");
      } catch (e) {
        console.error("hard reset failed, will retry", e);
        hardResetWithBackoff("retry after fail");
      }
    }, delay);
  });

  /* ---------- AVATAR EVENT HANDLERS (единая точка навешивания) ---------- */
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

    // ключевой обработчик обрыва
    avatar.on(StreamingEvents.STREAM_DISCONNECTED, async () => {
      console.warn("⚠️ STREAM_DISCONNECTED → soft restart & backoff hard reset");
      try {
        await softRestartTracks();
      } finally {
        hardResetWithBackoff("stream disconnected");
      }
    });
  });

  /* ---------- START SESSION (VOICE / TEXT) ---------- */
  const startSessionV2 = useMemoizedFn(async (isVoiceChat: boolean) => {
    try {
      isVoiceChatRef.current = isVoiceChat;

      const newToken = await fetchAccessToken();
      const avatar = initAvatar(newToken);
      avatarRef.current = avatar;

      setupAvatarEventHandlers(avatar);

      const extendedConfig: StartAvatarRequest = {
        ...configRef.current,
        activityIdleTimeout: 3600, // максимум 1 час
      };
      await startAvatar(extendedConfig);

      // keepAlive каждые 5 минут — только в здоровом состоянии
      if (keepAliveIntervalRef.current == null) {
        keepAliveIntervalRef.current = window.setInterval(() => {
          if (isHealthy() && avatarRef.current?.keepAlive) {
            avatarRef.current.keepAlive();
          }
        }, 300000);
      }

      if (isVoiceChat && isHealthy()) {
        await startVoiceChat();
      }
    } catch (error) {
      console.error("Error starting avatar session:", error);
    }
  });

  /* ---------- SILENT PERIODIC RECYCLE (раз в 10 минут) ---------- */
  useEffect(() => {
    const TEN_MIN = 10 * 60 * 1000;
    const id = window.setInterval(async () => {
      // если офлайн или нет активной сессии — пропускаем
      if (!navigator.onLine || !avatarRef.current) return;

      try {
        console.info("♻️ Silent recycle started");
        await stopAvatar();
        avatarRef.current = null;
        await new Promise((r) => setTimeout(r, 500));

        const token = await fetchAccessToken();
        const newAvatar = initAvatar(token);
        avatarRef.current = newAvatar;
        setupAvatarEventHandlers(newAvatar);

        await startAvatar({
          ...configRef.current,
          activityIdleTimeout: 3600,
        });

        if (isVoiceChatRef.current && isHealthy()) {
          await startVoiceChat();
        }
        console.info("✅ Silent recycle done");
      } catch (e) {
        console.error("♻️ Recycle failed", e);
        // если регулярный рецикл провалился — эскалируем
        hardResetWithBackoff("recycle failed");
      }
    }, TEN_MIN);

    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // таймер один на жизнь компонента

  /* ---------- ONLINE / OFFLINE ---------- */
  useEffect(() => {
    const onOnline = () => hardResetWithBackoff("browser online");
    const onOffline = () => console.warn("⚠️ browser offline");
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
