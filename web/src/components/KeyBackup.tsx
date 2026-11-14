"use client";

import { useState, useSyncExternalStore } from "react";
import { backupOf, isBackedUp, markBackedUp, parseBackup, restoreKey, type Backup, type Role } from "@/lib/keys";
import { implicitId } from "@/lib/near";
import { AlertIcon, DownloadIcon } from "./icons";
import { Button, Card, CopyButton, Notice, shortId } from "./ui";

const subscribers = new Set<() => void>();
const subscribe = (fn: () => void) => {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
};
const notify = () => subscribers.forEach((fn) => fn());

/** Whether this browser's key for the role has been backed up. */
export function useBackedUp(role: Role): boolean {
  return useSyncExternalStore(
    subscribe,
    () => isBackedUp(role),
    () => true,
  );
}

function backupText(backup: Backup): string {
  return backup.kind === "phrase" ? backup.words.join(" ") : backup.secret;
}

function download(role: Role, accountId: string, backup: Backup) {
  const body = [
    `Payday ${role} account recovery`,
    `Account: ${accountId}`,
    "",
    backup.kind === "phrase" ? "Recovery phrase:" : "Secret key:",
    backupText(backup),
    "",
    "Anyone with this can move the money in this account. Keep it offline and private.",
  ].join("\n");
  const url = URL.createObjectURL(new Blob([body], { type: "text/plain" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `payday-${role}-recovery.txt`;
  link.click();
  // Revoking at once can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** A short, dismissible prompt shown until the account is backed up. */
export function BackupBanner({ role, onOpen }: { role: Role; onOpen: () => void }) {
  const backedUp = useBackedUp(role);
  if (backedUp) return null;
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-border bg-warn-soft px-4 py-3 text-sm">
      <AlertIcon className="shrink-0" />
      <p className="flex-1">
        Your account lives only in this browser. Back it up now, or clearing your browser loses the money in it.
      </p>
      <Button variant="secondary" onClick={onOpen}>
        Back up
      </Button>
    </div>
  );
}

/**
 * Shows the recovery phrase (or, for older accounts, the secret key) on request, and
 * restores a different account from one.
 */
export function KeyBackup({ role, accountId }: { role: Role; accountId: string }) {
  const [revealed, setRevealed] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const backedUp = useBackedUp(role);
  const backup = backupOf(role);

  async function restore() {
    setError(null);
    let restoredId: string;
    try {
      restoredId = implicitId(parseBackup(input).keyPair);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return;
    }
    if (restoredId === accountId) {
      setError("That is the account this browser already has.");
      return;
    }
    // Restoring replaces the only copy of the current key, so it must be saved first.
    if (!backedUp) {
      setError("Back up this browser's account first: reveal its phrase above and confirm you saved it.");
      return;
    }
    const replace = window.confirm(
      `Replace this browser's account (${shortId(accountId)}) with ${shortId(restoredId)}? ` +
        "Keep the current account's recovery phrase: it is the only way back to it.",
    );
    if (!replace) return;
    try {
      await restoreKey(role, input);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return;
    }
    window.location.reload();
  }

  return (
    <Card title="Back up this account" aside={backedUp ? <span className="text-xs text-accent">Backed up</span> : null}>
      <p className="text-sm text-muted">
        Payday keeps your account key in this browser only, locked so no page or extension can read it out. Until you
        confirm your backup, the recovery {backup?.kind === "key" ? "key" : "phrase"} is also kept here so you can see it;
        write it down somewhere safe: it is the only way back in from another browser, and anyone who has it can move
        your money.
      </p>

      {!backup && backedUp && (
        <p className="mt-4 rounded-xl border border-border bg-bg p-4 text-sm text-muted">
          Your recovery phrase is no longer stored in this browser: only the copy you saved can restore this account
          elsewhere. If you have lost it, move your money to a new account while this browser still has the key.
        </p>
      )}

      {backup && (
        <div className="mt-4">
          <div className="num relative rounded-xl border border-border bg-bg p-4 text-sm">
            {!revealed ? (
              // Nothing secret is rendered until it is asked for: not even blurred.
              <p className="text-muted">Hidden. Make sure nobody can see your screen, then reveal it.</p>
            ) : backup.kind === "phrase" ? (
              <ol className="grid grid-cols-3 gap-x-4 gap-y-1.5 sm:grid-cols-4">
                {backup.words.map((w, i) => (
                  <li key={i}>
                    <span className="mr-1.5 text-muted">{i + 1}.</span>
                    {w}
                  </li>
                ))}
              </ol>
            ) : (
              <p className="break-all">{backup.secret}</p>
            )}
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {!revealed ? (
              <Button variant="secondary" onClick={() => setRevealed(true)}>
                Reveal
              </Button>
            ) : (
              <>
                <CopyButton value={backupText(backup)} label="Copy" />
                <Button variant="ghost" onClick={() => download(role, accountId, backup)}>
                  <DownloadIcon /> Download
                </Button>
                {!backedUp && (
                  <Button
                    onClick={() => {
                      const sure = window.confirm(
                        "Payday will delete the phrase from this browser, so your saved copy will be the only one. Continue?",
                      );
                      if (!sure) return;
                      markBackedUp(role);
                      notify();
                    }}
                  >
                    I have saved it
                  </Button>
                )}
              </>
            )}
          </div>
        </div>
      )}

      <div className="mt-6 border-t border-border pt-4">
        {!restoring ? (
          <button className="text-sm text-muted underline underline-offset-4 hover:text-text" onClick={() => setRestoring(true)}>
            Restore a different account
          </button>
        ) : (
          <div className="space-y-3">
            <textarea
              className="num h-24 w-full rounded-xl border border-border bg-bg p-3 text-sm focus:border-accent focus:outline-none"
              placeholder="12-word recovery phrase, or a secret key starting with ed25519:"
              spellCheck={false}
              autoComplete="off"
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                setError(null);
              }}
            />
            {error && <Notice tone="error">{error}</Notice>}
            <div className="flex gap-2">
              <Button variant="secondary" disabled={!input.trim()} onClick={restore}>
                Restore
              </Button>
              <Button variant="ghost" onClick={() => setRestoring(false)}>
                Cancel
              </Button>
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}

/**
 * Shown instead of the dashboard when this browser knew an account but lost its key. A new
 * account is not created silently: the user restores the old one, or knowingly another.
 */
export function MissingKey({ role, accountId }: { role: Role; accountId: string }) {
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function restore() {
    setError(null);
    let restoredId: string;
    try {
      restoredId = implicitId(parseBackup(input).keyPair);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return;
    }
    if (
      restoredId !== accountId &&
      !window.confirm(`That phrase opens ${shortId(restoredId)}, not ${shortId(accountId)}. Use it anyway?`)
    ) {
      return;
    }
    try {
      await restoreKey(role, input);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return;
    }
    window.location.reload();
  }

  return (
    <Card title="Restore your account">
      <Notice tone="error">
        This browser no longer has the key for <span className="num break-all">{accountId}</span>, usually because some
        site data was cleared. Its money is safe on-chain: enter its recovery phrase to get back in.
      </Notice>
      <div className="mt-4 space-y-3">
        <textarea
          className="num h-24 w-full rounded-xl border border-border bg-bg p-3 text-sm focus:border-accent focus:outline-none"
          placeholder="12-word recovery phrase, or a secret key starting with ed25519:"
          spellCheck={false}
          autoComplete="off"
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            setError(null);
          }}
        />
        {error && <Notice tone="error">{error}</Notice>}
        <Button disabled={!input.trim()} onClick={restore}>
          Restore
        </Button>
      </div>
    </Card>
  );
}
