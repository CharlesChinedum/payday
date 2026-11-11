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
  URL.revokeObjectURL(url);
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

  function restore() {
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
    const replace = window.confirm(
      `Replace this browser's account (${shortId(accountId)}) with ${shortId(restoredId)}? ` +
        "If the current account holds money, back it up first.",
    );
    if (!replace) return;
    restoreKey(role, input);
    window.location.reload();
  }

  return (
    <Card title="Back up this account" aside={backedUp ? <span className="text-xs text-accent">Backed up</span> : null}>
      <p className="text-sm text-muted">
        Payday keeps your account key in this browser only. Write the recovery {backup?.kind === "key" ? "key" : "phrase"}{" "}
        down somewhere safe: it is the only way back in from another browser, and anyone who has it can move your money.
      </p>

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
