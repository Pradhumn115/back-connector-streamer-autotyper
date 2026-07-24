import { useState } from "react";
import type { ClientMessage } from "@bcsa/shared";
import type { AutotypeStatus } from "../connect/useConnection";

interface AutotypePanelProps {
  send: (msg: ClientMessage) => void;
  autotype: AutotypeStatus;
  disabled: boolean;
}

const DEFAULT_BASE_DELAY = 90;
const DEFAULT_JITTER = 60;
const DEFAULT_TYPO_RATE = 0.03;

/**
 * Panel to compose text and an autotype profile, fire the autotype message,
 * and show progress driven by autotypeProgress / autotypeDone.
 */
export function AutotypePanel({ send, autotype, disabled }: AutotypePanelProps) {
  const [text, setText] = useState<string>("");
  const [baseDelayMs, setBaseDelayMs] = useState<number>(DEFAULT_BASE_DELAY);
  const [jitterMs, setJitterMs] = useState<number>(DEFAULT_JITTER);
  const [typoRate, setTypoRate] = useState<number>(DEFAULT_TYPO_RATE);

  const onTypeIt = () => {
    if (!text) return;
    send({
      type: "autotype",
      text,
      profile: { baseDelayMs, jitterMs, typoRate },
    });
  };

  const pct =
    autotype.total > 0
      ? Math.min(100, Math.round((autotype.done / autotype.total) * 100))
      : 0;

  return (
    <div className="autotype-panel">
      <h3>Autotype</h3>
      <textarea
        className="autotype-text"
        placeholder="Text to type into the agent…"
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={6}
      />

      <label className="field">
        <span>
          Base delay <em>{baseDelayMs} ms</em>
        </span>
        <input
          type="range"
          min={0}
          max={500}
          step={5}
          value={baseDelayMs}
          onChange={(e) => setBaseDelayMs(Number(e.target.value))}
        />
      </label>

      <label className="field">
        <span>
          Jitter <em>{jitterMs} ms</em>
        </span>
        <input
          type="range"
          min={0}
          max={400}
          step={5}
          value={jitterMs}
          onChange={(e) => setJitterMs(Number(e.target.value))}
        />
      </label>

      <label className="field">
        <span>
          Typo rate <em>{typoRate.toFixed(2)}</em>
        </span>
        <input
          type="range"
          min={0}
          max={0.3}
          step={0.01}
          value={typoRate}
          onChange={(e) => setTypoRate(Number(e.target.value))}
        />
      </label>

      <button
        className="type-it"
        onClick={onTypeIt}
        disabled={disabled || text.length === 0}
      >
        Type it
      </button>

      <div className="progress">
        <div className="progress-bar" style={{ width: `${pct}%` }} />
        <span className="progress-label">
          {autotype.total > 0
            ? `${autotype.done} / ${autotype.total} (${pct}%)`
            : autotype.active
              ? "starting…"
              : "idle"}
        </span>
      </div>
    </div>
  );
}
