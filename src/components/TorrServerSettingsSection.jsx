// ── TorrServer / Jackett settings section (rendered inside SettingsPage) ────
// Configures the "Торренты" source backend. TorrServer host + Jackett search
// + preferred audio language + external player. Persisted via the main-process
// torrset-cfg IPC (which writes userData/lampa-stream-torrserver.json).

import { useEffect, useState } from "react";
import {
  torrGetCfg,
  torrSetCfg,
  torrPing,
} from "../utils/torrserver-client";
import { WarningIcon } from "./Icons";

export default function TorrServerSettingsSection() {
  const [torrserverUrl, setTorrserverUrl] = useState("http://127.0.0.1:8090");
  const [jackettUrl, setJackettUrl] = useState("");
  const [jackettKey, setJackettKey] = useState("");
  const [preferAudio, setPreferAudio] = useState("ru");
  const [externalPlayer, setExternalPlayer] = useState("auto");
  const [saved, setSaved] = useState(false);
  const [test, setTest] = useState(null); // {ok,matrix,base,error}
  const [testing, setTesting] = useState(false);
  const [tmdbProxy, setTmdbProxy] = useState(true);

  useEffect(() => {
    (async () => {
      const c = (await torrGetCfg()) || {};
      setTorrserverUrl(c.torrserverUrl || "http://127.0.0.1:8090");
      setJackettUrl(c.jackettUrl || "");
      setJackettKey(c.jackettKey || "");
      setPreferAudio(c.preferAudio || "ru");
      setExternalPlayer(c.externalPlayer || "auto");
      // Auto-test on load so the user sees connection state immediately
      doTest(c.torrserverUrl || "http://127.0.0.1:8090");
      // Load TMDB proxy state (default on — for Russia / no-VPN)
      try {
        const p = await window.electron?.tmdbProxyGet?.();
        if (p) setTmdbProxy(!!p.on);
      } catch {}
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleTmdbProxy = async (on) => {
    setTmdbProxy(on);
    try { await window.electron?.tmdbProxySet?.({ on }); } catch {}
  };

  const save = async () => {
    await torrSetCfg({ torrserverUrl: torrserverUrl.trim() || "http://127.0.0.1:8090", jackettUrl: jackettUrl.trim(), jackettKey: jackettKey.trim(), preferAudio, externalPlayer });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const doTest = async (url) => {
    setTesting(true);
    setTest(null);
    const r = await torrPing();
    setTesting(false);
    setTest(r || { ok: false, error: "no response" });
  };

  const inputStyle = {
    flex: 1,
    minWidth: 260,
    padding: "9px 12px",
    background: "var(--surface2)",
    border: "1px solid var(--border)",
    borderRadius: 8,
    color: "var(--text)",
    fontFamily: "var(--font-body)",
    fontSize: 14,
  };
  const labelStyle = { fontSize: 13, color: "var(--text2)", marginBottom: 6, marginTop: 14 };
  const descStyle = { fontSize: 12, color: "var(--text3)", lineHeight: 1.5, marginBottom: 8 };

  return (
    <div style={{ marginBottom: 40 }}>
      <div className="settings-section-title">TorrServer</div>
      <div style={descStyle}>
        Источник «Торренты» стримит торрент-файлы через локальный{" "}
        <b>TorrServer</b> (YouROK MatriX). Русская озвучка берётся из самих
        раздач. Запустите TorrServer (по умолчанию{" "}
        <code>http://127.0.0.1:8090</code>) — он уже настроен у вас через Lampa.
      </div>

      {/* TMDB proxy toggle — also lives in this "Lampa integration" section */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          padding: "12px 14px",
          background: "var(--surface2)",
          border: "1px solid var(--border)",
          borderRadius: 8,
          marginBottom: 16,
        }}
      >
        <div>
          <div style={{ fontSize: 14, color: "var(--text)", fontWeight: 600 }}>
            TMDB-прокси (Россия, без VPN)
          </div>
          <div style={{ fontSize: 12, color: "var(--text3)", marginTop: 3, lineHeight: 1.5 }}>
            Проксирует каталог TMDB (api.themoviedb.org) и постеры через
            tmdb-api.rootu.top / tmdb-img.rootu.top. Включите, если TMDB
            заблокирован в вашем регионе. Каталог работает без личного токена
            (вшит общий ключ).
          </div>
        </div>
        <button
          className="btn"
          onClick={() => toggleTmdbProxy(!tmdbProxy)}
          style={{
            flexShrink: 0,
            color: tmdbProxy ? "#fff" : "var(--text2)",
            background: tmdbProxy ? "var(--red)" : "var(--surface3)",
            border: tmdbProxy ? "1px solid transparent" : "1px solid var(--border)",
            whiteSpace: "nowrap",
          }}
        >
          {tmdbProxy ? "Включён" : "Выключен"}
        </button>
      </div>

      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <input
          className="apikey-input"
          style={inputStyle}
          value={torrserverUrl}
          onChange={(e) => setTorrserverUrl(e.target.value)}
          placeholder="http://127.0.0.1:8090"
        />
        <button
          className="btn"
          onClick={() => doTest()}
          disabled={testing}
          style={{ whiteSpace: "nowrap" }}
        >
          {testing ? "Проверка…" : "Проверить"}
        </button>
        <span style={{ fontSize: 13 }}>
          {test?.ok ? (
            <span style={{ color: "#4caf50" }}>
              ✓ TorrServer (MatriX) на связи{test.base ? ` — ${test.base}` : ""}
            </span>
          ) : test ? (
            <span style={{ color: "var(--red)", display: "inline-flex", gap: 6, alignItems: "center" }}>
              <WarningIcon size={15} /> {test.error || "недоступен"}
            </span>
          ) : null}
        </span>
      </div>

      <div style={labelStyle}>Jackett URL (для автопоиска торрентов)</div>
      <input
        className="apikey-input"
        style={inputStyle}
        value={jackettUrl}
        onChange={(e) => setJackettUrl(e.target.value)}
        placeholder="http://127.0.0.1:9117  (оставьте пустым, если добавляете magnet вручную)"
      />
      <div style={descStyle}>
        Любой Jackett-совместимый индексер. <code>jacred.xyz</code> — публичный
        агрегатор Lampa, но без API-ключа поиск может быть недоступен; лучше
        указать свой Jackett.
      </div>

      <div style={labelStyle}>Jackett API key</div>
      <input
        className="apikey-input"
        style={inputStyle}
        value={jackettKey}
        onChange={(e) => setJackettKey(e.target.value)}
        placeholder="ваш Jackett api key (настройки Jackett)"
      />

      <div style={labelStyle}>Предпочитаемая аудиодорожка</div>
      <select
        value={preferAudio}
        onChange={(e) => setPreferAudio(e.target.value)}
        style={{ ...inputStyle, maxWidth: 220 }}
      >
        <option value="ru">Русский (RU)</option>
        <option value="en">English</option>
        <option value="original">Оригинал</option>
      </select>

      <div style={labelStyle}>Внешний плеер (mpv/VLC) — гарантия русского звука</div>
      <select
        value={externalPlayer}
        onChange={(e) => setExternalPlayer(e.target.value)}
        style={{ ...inputStyle, maxWidth: 260 }}
      >
        <option value="auto">Авто (сначала mpv)</option>
        <option value="mpv">mpv</option>
        <option value="vlc">VLC</option>
      </select>
      <div style={descStyle}>
        Кнопка «↗» в плеере открывает поток в системном плеере — mpv/VLC умеют
        переключать любые дорожки и всегда корректно играют mkv с русской
        озвучкой.
      </div>

      <div style={{ display: "flex", gap: 12, alignItems: "center", marginTop: 10 }}>
        <button className="btn" style={{ background: "var(--red)", color: "#fff" }} onClick={save}>
          Сохранить
        </button>
        {saved && <span style={{ color: "#4caf50", fontSize: 13 }}>✓ Сохранено</span>}
      </div>
    </div>
  );
}