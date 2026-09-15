"use client";

import { useEffect, useState } from "react";

type SessionItem = {
  id: string;
  current: boolean;
  user_agent: string | null;
  ip_address: string | null;
  expires_at: string;
  last_seen_at: string;
  created_at: string;
};

type SessionsResponse = {
  sessions: SessionItem[];
};

type LoadState = "loading" | "ready" | "unauthenticated" | "error";

type SessionsLoadResult =
  | { status: "ready"; sessions: SessionItem[] }
  | { status: "unauthenticated" | "error"; error: string };

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "short",
    timeStyle: "short"
  }).format(new Date(value));
}

function getErrorMessage(status: number): string {
  if (status === 401) {
    return "Sua sess\u00e3o expirou. Entre novamente para continuar.";
  }

  return "N\u00e3o foi poss\u00edvel carregar suas sess\u00f5es.";
}

async function fetchSessions(): Promise<SessionsLoadResult> {
  try {
    const response = await fetch("/api/auth/sessions", {
      cache: "no-store"
    });

    if (!response.ok) {
      return {
        error: getErrorMessage(response.status),
        status: response.status === 401 ? "unauthenticated" : "error"
      };
    }

    const body = (await response.json()) as SessionsResponse;
    return {
      sessions: body.sessions,
      status: "ready"
    };
  } catch {
    return {
      error: "N\u00e3o foi poss\u00edvel conectar ao GESTOR GMAP.",
      status: "error"
    };
  }
}

export function SessionsClient() {
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [sessions, setSessions] = useState<SessionItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [revokingSessionId, setRevokingSessionId] = useState<string | null>(null);

  function applySessionsResult(result: SessionsLoadResult) {
    if (result.status === "ready") {
      setSessions(result.sessions);
      setError(null);
      setLoadState("ready");
      return;
    }

    setError(result.error);
    setLoadState(result.status);
  }

  useEffect(() => {
    let active = true;

    async function loadInitialSessions() {
      const result = await fetchSessions();

      if (active) {
        applySessionsResult(result);
      }
    }

    void loadInitialSessions();

    return () => {
      active = false;
    };
  }, []);

  async function retryLoadSessions() {
    setLoadState("loading");
    setError(null);
    applySessionsResult(await fetchSessions());
  }

  async function revokeSession(session: SessionItem) {
    setError(null);
    setRevokingSessionId(session.id);

    try {
      const response = await fetch(`/api/auth/sessions/${encodeURIComponent(session.id)}`, {
        method: "DELETE"
      });

      if (!response.ok) {
        setError(
          response.status === 401
            ? "Sua sess\u00e3o expirou. Entre novamente para continuar."
            : "N\u00e3o foi poss\u00edvel encerrar a sess\u00e3o."
        );
        if (response.status === 401) {
          setLoadState("unauthenticated");
        }
        return;
      }

      if (session.current) {
        setLoadState("unauthenticated");
        setSessions([]);
        setError("Sess\u00e3o atual encerrada. Entre novamente para continuar.");
        return;
      }

      setSessions((currentSessions) => currentSessions.filter((item) => item.id !== session.id));
    } catch {
      setError("N\u00e3o foi poss\u00edvel conectar ao GESTOR GMAP.");
    } finally {
      setRevokingSessionId(null);
    }
  }

  if (loadState === "loading") {
    return <p className="mt-6 text-sm text-[#5c667a]">{"Carregando sess\u00f5es..."}</p>;
  }

  if (loadState === "unauthenticated") {
    return (
      <div className="mt-6 rounded-md border border-[#f0b4a8] bg-[#fff3f0] p-4 text-sm text-[#7a271a]">
        <p role="alert">{error ?? "Sua sess\u00e3o expirou. Entre novamente para continuar."}</p>
        <a
          href="/login"
          className="mt-3 inline-flex min-h-10 items-center rounded-md bg-[#176a5e] px-4 font-bold text-white transition-colors hover:bg-[#12564d] focus:ring-2 focus:ring-[#176a5e] focus:ring-offset-2 focus:outline-none"
        >
          Entrar novamente
        </a>
      </div>
    );
  }

  if (loadState === "error") {
    return (
      <div className="mt-6 rounded-md border border-[#f0b4a8] bg-[#fff3f0] p-4 text-sm text-[#7a271a]">
        <p role="alert">{error ?? "N\u00e3o foi poss\u00edvel carregar suas sess\u00f5es."}</p>
        <button
          type="button"
          onClick={() => void retryLoadSessions()}
          className="mt-3 min-h-10 rounded-md bg-[#176a5e] px-4 font-bold text-white transition-colors hover:bg-[#12564d] focus:ring-2 focus:ring-[#176a5e] focus:ring-offset-2 focus:outline-none"
        >
          Tentar novamente
        </button>
      </div>
    );
  }

  return (
    <div className="mt-6 grid gap-4">
      {error ? (
        <p
          className="rounded-md border border-[#f0b4a8] bg-[#fff3f0] px-3 py-2 text-sm font-medium text-[#9b2c1d]"
          role="alert"
        >
          {error}
        </p>
      ) : null}

      {sessions.length === 0 ? (
        <p className="rounded-md border border-[#d9dee8] bg-[#f7f8fa] p-4 text-sm text-[#5c667a]">
          {"Nenhuma sess\u00e3o ativa encontrada."}
        </p>
      ) : (
        <ul className="grid gap-3" aria-label="Sess\u00f5es ativas">
          {sessions.map((session) => (
            <li key={session.id} className="rounded-lg border border-[#d9dee8] bg-[#fbfcfd] p-4">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0 space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="break-words font-bold text-[#162033]">
                      {session.user_agent ?? "Dispositivo n\u00e3o identificado"}
                    </p>
                    {session.current ? (
                      <span className="rounded-md bg-[#dff3ed] px-2 py-1 text-xs font-bold text-[#176a5e]">
                        {"Sess\u00e3o atual"}
                      </span>
                    ) : null}
                  </div>
                  <dl className="grid gap-1 text-sm text-[#5c667a] sm:grid-cols-2">
                    <div>
                      <dt className="font-bold text-[#253149]">IP</dt>
                      <dd>{session.ip_address ?? "N\u00e3o informado"}</dd>
                    </div>
                    <div>
                      <dt className="font-bold text-[#253149]">{"\u00daltimo uso"}</dt>
                      <dd>{formatDateTime(session.last_seen_at)}</dd>
                    </div>
                    <div>
                      <dt className="font-bold text-[#253149]">Criada em</dt>
                      <dd>{formatDateTime(session.created_at)}</dd>
                    </div>
                    <div>
                      <dt className="font-bold text-[#253149]">Expira em</dt>
                      <dd>{formatDateTime(session.expires_at)}</dd>
                    </div>
                  </dl>
                </div>
                <button
                  type="button"
                  onClick={() => void revokeSession(session)}
                  disabled={revokingSessionId === session.id}
                  className="min-h-10 shrink-0 rounded-md border border-[#9b2c1d] px-4 text-sm font-bold text-[#9b2c1d] transition-colors hover:bg-[#fff3f0] focus:ring-2 focus:ring-[#9b2c1d] focus:ring-offset-2 focus:outline-none disabled:cursor-not-allowed disabled:border-[#c9a29a] disabled:text-[#9f7b74]"
                >
                  {revokingSessionId === session.id ? "Encerrando..." : "Encerrar"}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
