"use client";

import { usePathname } from "next/navigation";
import { type ReactNode, useEffect, useRef, useState } from "react";

const ACTIVE_TAB_STORAGE_KEY = "gestor-gmap:active-operational-tab";
const HEARTBEAT_MS = 2_000;
const STALE_AFTER_MS = 8_000;

type ActiveTabRecord = {
  tabId: string;
  path: string;
  lastSeenAt: number;
};

type OperationalTabGuardProps = {
  children: ReactNode;
};

function isOperationalPath(pathname: string | null): boolean {
  return pathname === "/sessoes" || Boolean(pathname?.startsWith("/sessoes/"));
}

function createTabId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function readActiveTabRecord(): ActiveTabRecord | null {
  try {
    const rawRecord = window.localStorage.getItem(ACTIVE_TAB_STORAGE_KEY);

    if (rawRecord === null) {
      return null;
    }

    const record = JSON.parse(rawRecord) as Partial<ActiveTabRecord>;

    if (
      typeof record.tabId !== "string" ||
      typeof record.path !== "string" ||
      typeof record.lastSeenAt !== "number"
    ) {
      return null;
    }

    return {
      tabId: record.tabId,
      path: record.path,
      lastSeenAt: record.lastSeenAt
    };
  } catch {
    return null;
  }
}

function isFreshRecord(record: ActiveTabRecord, now: number): boolean {
  return now - record.lastSeenAt < STALE_AFTER_MS;
}

function writeActiveTabRecord(tabId: string, path: string, now = Date.now()): void {
  window.localStorage.setItem(
    ACTIVE_TAB_STORAGE_KEY,
    JSON.stringify({
      tabId,
      path,
      lastSeenAt: now
    } satisfies ActiveTabRecord)
  );
}

function releaseActiveTabRecord(tabId: string): void {
  const record = readActiveTabRecord();

  if (record?.tabId === tabId) {
    window.localStorage.removeItem(ACTIVE_TAB_STORAGE_KEY);
  }
}

export function OperationalTabGuard({ children }: OperationalTabGuardProps) {
  const pathname = usePathname();
  const tabIdRef = useRef<string | null>(null);
  const [blocked, setBlocked] = useState(false);
  const operational = isOperationalPath(pathname);
  const showBlockedOverlay = operational && blocked;

  useEffect(() => {
    if (!operational || pathname === null) {
      if (tabIdRef.current !== null) {
        releaseActiveTabRecord(tabIdRef.current);
      }

      return;
    }

    const tabId = tabIdRef.current ?? createTabId();
    tabIdRef.current = tabId;

    function claimOrBlock() {
      const now = Date.now();
      const record = readActiveTabRecord();

      if (record !== null && record.tabId !== tabId && isFreshRecord(record, now)) {
        setBlocked(true);
        return;
      }

      writeActiveTabRecord(tabId, pathname, now);
      setBlocked(false);
    }

    function releaseCurrentTab() {
      releaseActiveTabRecord(tabId);
    }

    claimOrBlock();

    const interval = window.setInterval(claimOrBlock, HEARTBEAT_MS);

    function handleStorage(event: StorageEvent) {
      if (event.key === ACTIVE_TAB_STORAGE_KEY) {
        claimOrBlock();
      }
    }

    window.addEventListener("storage", handleStorage);
    window.addEventListener("pagehide", releaseCurrentTab);

    return () => {
      window.clearInterval(interval);
      window.removeEventListener("storage", handleStorage);
      window.removeEventListener("pagehide", releaseCurrentTab);
      releaseCurrentTab();
    };
  }, [operational, pathname]);

  function assumeThisTab() {
    if (tabIdRef.current === null || pathname === null) {
      return;
    }

    writeActiveTabRecord(tabIdRef.current, pathname);
    setBlocked(false);
  }

  return (
    <>
      {children}
      {showBlockedOverlay ? (
        <div
          aria-labelledby="operational-tab-title"
          aria-modal="true"
          className="fixed inset-0 z-50 grid place-items-center bg-[#162033]/85 px-5 text-[#162033]"
          role="alertdialog"
        >
          <section className="w-full max-w-lg rounded-lg border border-[#d9dee8] bg-white p-6 shadow-2xl sm:p-8">
            <p className="mb-3 text-xs font-bold uppercase text-[#176a5e]">GESTOR GMAP</p>
            <h2 id="operational-tab-title" className="text-2xl leading-tight font-bold">
              {"Outra aba operacional est\u00e1 ativa"}
            </h2>
            <p className="mt-3 leading-7 text-[#5c667a]">
              {
                "Para evitar conflito de uso, mantenha apenas uma aba operacional aberta. Feche a outra aba ou assuma esta aba para continuar."
              }
            </p>
            <button
              className="mt-5 min-h-11 rounded-md bg-[#176a5e] px-5 text-sm font-bold text-white transition-colors hover:bg-[#12564d] focus:ring-2 focus:ring-[#176a5e] focus:ring-offset-2 focus:outline-none"
              onClick={assumeThisTab}
              type="button"
            >
              {"Assumir esta aba"}
            </button>
          </section>
        </div>
      ) : null}
    </>
  );
}
