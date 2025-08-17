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
  activityIdleTimeout: 3600,
  voiceChatTransport: VoiceChatTransport.WEBSOCKET,
  sttSettings: { 
    provider: STTProvider.DEEPGRAM,
    confidence: 0.55 
  },
};

function InteractiveAvatar() {
  const { initAvatar, startAvatar, stopAvatar, sessionState, stream } =
    useStreamingAvatarSession();
  const { startVoiceChat, stopVoiceChat, isVoiceChatActive } = useVoiceChat();

  const [config, setConfig] = useState<StartAvatarRequest>(DEFAULT_CONFIG);
  const [webSocketErrors, setWebSocketErrors] = useState(0);
  
  const configRef = useRef(config);
  useEffect(() => {
    configRef.current = config;
  }, [config]);

  const isVoiceChatRef = useRef(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const keepAliveIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const watchdogIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const errorMonitorRef = useRef<NodeJS.Timeout | null>(null);
  const lastWebSocketErrorRef = useRef<number>(0);

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

  // Перезапуск только voice chat (для WebSocket ошибок)
  const restartVoiceChat = useMemoizedFn(async () => {
    if (sessionState !== StreamingAvatarSessionState.CONNECTED) return false;
    
    console.log("🎤 Restarting voice chat due to WebSocket error...");
    try {
      // Сначала останавливаем voice chat
      if (isVoiceChatActive) {
        await stopVoiceChat();
        await new Promise(r => setTimeout(r, 500)); // Небольшая пауза
      }
      
      // Затем запускаем заново
      await startVoiceChat();
      
      console.log("✅ Voice chat restarted successfully");
      setWebSocketErrors(0); // Сбрасываем счетчик ошибок
      return true;
    } catch (error: any) {
      console.error("❌ Voice chat restart failed:", error);
      return false;
    }
  });

  // Мягкий перезапуск медиа-потоков
  const softRestartTracks = useMemoizedFn(async () => {
    if (sessionState !== StreamingAvatarSessionState.CONNECTED) return;
    
    console.log("🔄 Attempting soft restart of media tracks...");
    try {
      await startVoiceChat();
      console.log("✅ Soft restart tracks completed successfully");
      setWebSocketErrors(0);
    } catch (e: any) {
      const msg = e?.message || "";
      if (msg.includes("400") || msg.includes("already")) {
        console.warn("⚠️ Soft restart: already listening (benign error)");
      } else if (msg.includes("401")) {
        console.warn("⚠️ Token expired, need full restart");
        throw e;
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
      await stopAvatar();
      
      if (keepAliveIntervalRef.current) {
        clearInterval(keepAliveIntervalRef.current);
        keepAliveIntervalRef.current = null;
      }
      
      await new Promise(r => setTimeout(r, 1000));
      
      const token = await fetchAccessToken();
      const avatar = initAvatar(token);
      
      setupEventListeners(avatar);
      
      await startAvatar(configRef.current);
      
      if (isVoiceChatRef.current) {
        await startVoiceChat();
      }
      
      setupKeepAlive(avatar);
      setWebSocketErrors(0);
      
      console.log("✅ Hard reset completed successfully");
    } catch (error) {
      console.error("❌ Hard reset failed:", error);
    }
  });

  // Настройка обработчиков событий
  const setupEventListeners = (avatar: any) => {
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
      setWebSocketErrors(0);
    });
  };

  // Настройка keepAlive
  const setupKeepAlive = (avatar: any) => {
    if (keepAliveIntervalRef.current) {
      clearInterval(keepAliveIntervalRef.current);
    }
    
    keepAliveIntervalRef.current = setInterval(() => {
      if (avatar && avatar.keepAlive) {
        avatar.keepAlive();
        console.log("💓 Keep-alive signal sent");
      }
    }, 300000);
  };

  // Запуск сессии
  const startSession = useMemoizedFn(async (needVoice: boolean) => {
    try {
      console.log("🚀 Starting avatar session...");
      
      const token = await fetchAccessToken();
      const avatar = initAvatar(token);
      
      setupEventListeners(avatar);
      
      await startAvatar(configRef.current);
      
      setupKeepAlive(avatar);
      
      if (needVoice) {
        await startVoiceChat();
        isVoiceChatRef.current = true;
      }
      
      console.log("✅ Session started successfully");
    } catch (error) {
      console.error("❌ Session start error:", error);
    }
  });

  // Мониторинг WebSocket ошибок в консоли
  useEffect(() => {
    const originalError = console.error;
    
    console.error = function(...args) {
      const errorMessage = args.join(' ');
      
      // Проверяем на WebSocket ошибки
      if (errorMessage.includes('WebSocket is already in CLOSING') || 
          errorMessage.includes('WebSocket is already in CLOSED')) {
        
        const now = Date.now();
        // Если прошло более 5 секунд с последней ошибки, увеличиваем счетчик
        if (now - lastWebSocketErrorRef.current > 5000) {
          setWebSocketErrors(prev => {
            const newCount = prev + 1;
            console.log(`🔌 WebSocket error detected (count: ${newCount})`);
            
            // После 3 ошибок пытаемся восстановить voice chat
            if (newCount === 3) {
              console.log("🎤 Multiple WebSocket errors detected, restarting voice chat...");
              restartVoiceChat().then(success => {
                if (!success && newCount > 5) {
                  // Если не удалось восстановить после 5 попыток - делаем soft restart
                  console.warn("🔄 Voice chat restart failed, attempting soft restart...");
                  softRestartTracks();
                }
              });
            } else if (newCount > 10) {
              // После 10 ошибок делаем hard reset
              console.warn("⚠️ Too many WebSocket errors, initiating hard reset...");
              hardReset();
              return 0; // Сброс счетчика будет в hardReset
            }
            
            return newCount;
          });
          lastWebSocketErrorRef.current = now;
        }
      }
      
      // Вызываем оригинальный console.error
      originalError.apply(console, args);
    };
    
    // Восстанавливаем оригинальный console.error при размонтировании
    return () => {
      console.error = originalError;
    };
  }, [restartVoiceChat, softRestartTracks, hardReset]);

  // Периодическая проверка состояния WebSocket
  useEffect(() => {
    errorMonitorRef.current = setInterval(() => {
      // Если накопилось много ошибок и прошло время, пробуем восстановить
      if (webSocketErrors > 0 && sessionState === StreamingAvatarSessionState.CONNECTED) {
        const timeSinceLastError = Date.now() - lastWebSocketErrorRef.current;
        
        // Если прошло более 30 секунд без новых ошибок, сбрасываем счетчик
        if (timeSinceLastError > 30000) {
          console.log("✅ No WebSocket errors for 30s, resetting error counter");
          setWebSocketErrors(0);
        }
        // Если ошибки продолжаются, но voice chat не активен, пробуем запустить
        else if (timeSinceLastError < 10000 && !isVoiceChatActive && isVoiceChatRef.current) {
          console.log("🎤 Voice chat inactive but should be active, restarting...");
          restartVoiceChat();
        }
      }
    }, 15000); // Проверяем каждые 15 секунд
    
    return () => {
      if (errorMonitorRef.current) {
        clearInterval(errorMonitorRef.current);
      }
    };
  }, [webSocketErrors, sessionState, isVoiceChatActive, restartVoiceChat]);

  // Очистка при размонтировании
  useUnmount(() => {
    console.log("🔚 Component unmounting, cleaning up...");
    
    if (keepAliveIntervalRef.current) {
      clearInterval(keepAliveIntervalRef.current);
    }
    
    if (watchdogIntervalRef.current) {
      clearInterval(watchdogIntervalRef.current);
    }
    
    if (errorMonitorRef.current) {
      clearInterval(errorMonitorRef.current);
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

  // Watchdog для обнаружения зависаний видео
  useEffect(() => {
    let previousTime = 0;
    let freezeCount = 0;
    const SOFT_LIMIT = 3;
    
    watchdogIntervalRef.current = setInterval(async () => {
      const video = videoRef.current;
      if (!video || sessionState !== StreamingAvatarSessionState.CONNECTED) return;
      
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
          await hardReset();
          freezeCount = 0;
        }
      } else {
        if (freezeCount > 0) {
          console.log("✅ Video recovered, resetting freeze counter");
          freezeCount = 0;
        }
      }
      
      previousTime = video.currentTime;
    }, 10000);
    
    return () => {
      if (watchdogIntervalRef.current) {
        clearInterval(watchdogIntervalRef.current);
      }
    };
  }, [softRestartTracks, hardReset, sessionState]);

  // UI с индикатором состояния WebSocket
  return (
    <div className="w-full flex flex-col gap-4">
      <div className="flex flex-col rounded-xl bg-zinc-900 overflow-hidden">
        <div className="relative w-full aspect-video flex items-center justify-center">
          {sessionState !== StreamingAvatarSessionState.INACTIVE ? (
            <>
              <AvatarVideo ref={videoRef} />
              {/* Индикатор WebSocket ошибок */}
              {webSocketErrors > 0 && (
                <div className="absolute top-2 right-2 bg-yellow-600 text-white px-2 py-1 rounded text-xs">
                  ⚠️ Audio issues ({webSocketErrors})
                </div>
              )}
            </>
          ) : (
            <AvatarConfig config={config} onConfigChange={setConfig} />
          )}
        </div>
        <div className="flex flex-col items-center gap-3 p-4 border-t border-zinc-700">
          {sessionState === StreamingAvatarSessionState.CONNECTED ? (
            <>
              <AvatarControls />
              {/* Кнопка ручного восстановления микрофона */}
              {webSocketErrors > 2 && (
                <Button 
                  onClick={restartVoiceChat}
                  className="!bg-yellow-600 text-xs"
                >
                  🎤 Fix Microphone
                </Button>
              )}
            </>
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
