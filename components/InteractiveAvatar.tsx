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
  quality: AvatarQuality.Medium,
  avatarName: AVATARS[0].avatar_id,
  knowledgeId: undefined,
  voice: {
    rate: 1.5,
    emotion: VoiceEmotion.EXCITED,
    model: ElevenLabsModel.eleven_flash_v2_5,
  },
  language: "en",
  activityIdleTimeout: 3600, // 1 час максимум
  voiceChatTransport: VoiceChatTransport.WEBSOCKET,
  sttSettings: { 
    provider: STTProvider.DEEPGRAM,
    confidence: 0.55 
  },
};

function InteractiveAvatar() {
  const { initAvatar, startAvatar, stopAvatar, sessionState, stream } =
    useStreamingAvatarSession();
  const { startVoiceChat } = useVoiceChat();

  const [config, setConfig] = useState<StartAvatarRequest>(DEFAULT_CONFIG);
  const configRef = useRef(config);
  useEffect(() => {
    configRef.current = config;
  }, [config]);

  const isVoiceChatRef = useRef(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const keepAliveIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const watchdogIntervalRef = useRef<NodeJS.Timeout | null>(null);

  // Получение токена
  const fetchAccessToken = async () => {
    try {
      const res = await fetch("/api/get-access-token", { method: "POST" });
      if (!res.ok) throw new Error(`Token fetch failed: ${res.status}`);
      return res.text();
    } catch (error) {
      console.error("Error fetching access token:", error);
      throw error;
    }
  };

  // Мягкий перезапуск медиа-потоков
  const softRestartTracks = useMemoizedFn(async () => {
    if (sessionState !== StreamingAvatarSessionState.CONNECTED) return;
    
    console.log("🔄 Attempting soft restart of media tracks...");
    try {
      await startVoiceChat();
      console.log("✅ Soft restart tracks completed successfully");
    } catch (e: any) {
      const msg = e?.message || "";
      // HeyGen возвращает 400 если уже слушает, 401 если токен устарел
      if (msg.includes("400") || msg.includes("already")) {
        console.warn("⚠️ Soft restart: already listening (benign error)");
      } else if (msg.includes("401")) {
        console.warn("⚠️ Token expired, need full restart");
        throw e; // Пробрасываем для hard reset
      } else {
        console.error("❌ Soft restart failed:", e);
        throw e;
      }
    }
  });

  // Полный перезапуск сессии
  const hardReset = useMemoizedFn(async () => {
    console.warn("🔴 Initiating HARD RESET of avatar session...");
    
    try {
      // Останавливаем текущую сессию
      await stopAvatar();
      
      // Очищаем интервалы
      if (keepAliveIntervalRef.current) {
        clearInterval(keepAliveIntervalRef.current);
        keepAliveIntervalRef.current = null;
      }
      
      // Ждем немного перед перезапуском
      await new Promise(r => setTimeout(r, 1000));
      
      // Получаем новый токен и создаем новую сессию
      const token = await fetchAccessToken();
      const avatar = initAvatar(token);
      
      // Подписываемся на события
      avatar.on(StreamingEvents.STREAM_DISCONNECTED, () => {
        console.warn("📡 Stream disconnected, attempting recovery...");
        softRestartTracks();
      });
      
      avatar.on(StreamingEvents.STREAM_READY, () => {
        console.log("✅ Stream ready after hard reset");
      });
      
      // Запускаем аватар с конфигом
      await startAvatar(configRef.current);
      
      // Восстанавливаем voice chat если был активен
      if (isVoiceChatRef.current) {
        await startVoiceChat();
      }
      
      // Восстанавливаем keepAlive
      setupKeepAlive(avatar);
      
      console.log("✅ Hard reset completed successfully");
    } catch (error) {
      console.error("❌ Hard reset failed:", error);
      // Можно добавить UI уведомление об ошибке
    }
  });

  // Настройка keepAlive для поддержания сессии
  const setupKeepAlive = (avatar: any) => {
    if (keepAliveIntervalRef.current) {
      clearInterval(keepAliveIntervalRef.current);
    }
    
    keepAliveIntervalRef.current = setInterval(() => {
      if (avatar && avatar.keepAlive) {
        avatar.keepAlive();
        console.log("💓 Keep-alive signal sent");
      }
    }, 300000); // каждые 5 минут
  };

  // Запуск сессии
  const startSession = useMemoizedFn(async (needVoice: boolean) => {
    try {
      console.log("🚀 Starting avatar session...");
      
      const token = await fetchAccessToken();
      const avatar = initAvatar(token);
      
      // Подписываемся на события
      avatar.on(StreamingEvents.STREAM_DISCONNECTED, () => {
        console.warn("📡 Stream disconnected, attempting recovery...");
        softRestartTracks();
      });
      
      avatar.on(StreamingEvents.AVATAR_START_TALKING, (e) => {
        console.log("🗣️ Avatar started talking", e);
      });
      
      avatar.on(StreamingEvents.AVATAR_STOP_TALKING, (e) => {
        console.log("🤐 Avatar stopped talking", e);
      });
      
      avatar.on(StreamingEvents.STREAM_READY, (event) => {
        console.log("✅ Stream ready:", event.detail);
      });

      // Запускаем аватар
      await startAvatar(configRef.current);
      
      // Настраиваем keepAlive
      setupKeepAlive(avatar);
      
      // Запускаем voice chat если нужно
      if (needVoice) {
        await startVoiceChat();
        isVoiceChatRef.current = true;
      }
      
      console.log("✅ Session started successfully");
    } catch (error) {
      console.error("❌ Session start error:", error);
    }
  });

  // Очистка при размонтировании
  useUnmount(() => {
    console.log("🔚 Component unmounting, cleaning up...");
    
    if (keepAliveIntervalRef.current) {
      clearInterval(keepAliveIntervalRef.current);
    }
    
    if (watchdogIntervalRef.current) {
      clearInterval(watchdogIntervalRef.current);
    }
    
    stopAvatar();
  });

  // Привязка видео
  useEffect(() => {
    if (stream && videoRef.current) {
      videoRef.current.srcObject = stream;
      videoRef.current.onloadedmetadata = () => {
        videoRef.current?.play();
      };
    }
  }, [stream]);

  // Watchdog для обнаружения зависаний
  useEffect(() => {
    let previousTime = 0;
    let freezeCount = 0;
    const SOFT_LIMIT = 3; // После 3 мягких перезапусков делаем hard reset
    
    watchdogIntervalRef.current = setInterval(async () => {
      const video = videoRef.current;
      if (!video || sessionState !== StreamingAvatarSessionState.CONNECTED) return;
      
      // Проверяем движется ли видео
      if (video.currentTime === previousTime) {
        console.warn(`⚠️ Video freeze detected (attempt ${freezeCount + 1}/${SOFT_LIMIT})`);
        
        try {
          await softRestartTracks();
          freezeCount++;
          
          if (freezeCount >= SOFT_LIMIT) {
            console.warn("⚠️ Soft restart limit reached, initiating hard reset...");
            freezeCount = 0;
            await hardReset();
          }
        } catch (error) {
          console.error("Error in watchdog recovery:", error);
          // При критической ошибке делаем hard reset
          await hardReset();
          freezeCount = 0;
        }
      } else {
        // Видео движется - сбрасываем счетчик
        if (freezeCount > 0) {
          console.log("✅ Video recovered, resetting freeze counter");
          freezeCount = 0;
        }
      }
      
      previousTime = video.currentTime;
    }, 10000); // Проверяем каждые 10 секунд
    
    return () => {
      if (watchdogIntervalRef.current) {
        clearInterval(watchdogIntervalRef.current);
      }
    };
  }, [softRestartTracks, hardReset, sessionState]);

  // UI
  return (
    <div className="w-full flex flex-col gap-4">
      <div className="flex flex-col rounded-xl bg-zinc-900 overflow-hidden">
        <div className="relative w-full aspect-video flex items-center justify-center">
          {sessionState !== StreamingAvatarSessionState.INACTIVE ? (
            <AvatarVideo ref={videoRef} />
          ) : (
            <AvatarConfig config={config} onConfigChange={setConfig} />
          )}
        </div>
        <div className="flex flex-col items-center gap-3 p-4 border-t border-zinc-700">
          {sessionState === StreamingAvatarSessionState.CONNECTED ? (
            <AvatarControls />
          ) : sessionState === StreamingAvatarSessionState.INACTIVE ? (
            <div className="flex gap-4">
              <Button onClick={() => startSession(true)}>Start Voice Chat</Button>
              <Button onClick={() => startSession(false)}>Start Text Chat</Button>
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
