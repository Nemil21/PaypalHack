import { useEffect, useState, type ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { agents, agentSnippets, type AgentClient } from '../../lib/landing';
import { ClaudeLogo, OpenAILogo, OpenCodeLogo } from '../logos';

const clients: readonly AgentClient[] = ['claude', 'codex', 'opencode'];
const clientLogo: Record<AgentClient, (p: { className?: string }) => ReactNode> = {
  claude: ClaudeLogo,
  codex: OpenAILogo,
  opencode: OpenCodeLogo,
};

/** Claude Code / Codex / OpenCode tabs with a COPY button; the snippet crossfades (120 ms). */
export function AgentCodeCard({
  className,
  token = null,
  footer,
}: {
  className?: string;
  /** A just-created token fills the snippets (W19); otherwise the hf_mcp_… placeholder. */
  token?: string | null;
  /** Extra line under the snippet, e.g. W19's "Then try: …". */
  footer?: ReactNode;
}) {
  const [client, setClient] = useState<AgentClient>('claude');
  const [copied, setCopied] = useState(false);
  const snippets = agentSnippets(
    typeof window === 'undefined' ? '' : window.location.origin,
    token,
  );
  const s = snippets[client];
  useEffect(() => setCopied(false), [client]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(s.code);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className={cn('min-w-0 self-start rounded-sm border border-line bg-surface', className)}>
      <div className="flex items-stretch justify-between border-b border-line bg-white">
        <div role="tablist" aria-label="MCP client" className="flex min-w-0 overflow-x-auto">
          {clients.map((c) => {
            const Logo = clientLogo[c];
            const on = c === client;
            return (
              <button
                key={c}
                type="button"
                role="tab"
                id={`agent-tab-${c}`}
                aria-selected={on}
                aria-controls="agent-snippet"
                onClick={() => setClient(c)}
                className={cn(
                  'flex shrink-0 items-center gap-1.5 border-b-2 px-2.5 py-3 font-mono text-[11px] sm:gap-2 sm:px-4 sm:text-[13px]',
                  on ? 'border-ink text-ink' : 'border-transparent text-body hover:text-ink',
                )}
              >
                <Logo className="size-3.5" />
                {snippets[c].label}
              </button>
            );
          })}
        </div>
        <div className="flex items-center pr-2 pl-2">
          <button
            type="button"
            onClick={copy}
            className="label rounded-[2px] border border-border px-2 py-1 text-[11px] text-ink hover:bg-surface"
          >
            {agents.copy}
          </button>
        </div>
      </div>
      <div
        id="agent-snippet"
        role="tabpanel"
        aria-labelledby={`agent-tab-${client}`}
        key={client}
        className="hf-fade p-4 sm:p-5"
      >
        <p className="font-mono text-[12px] text-muted">{s.comment}</p>
        <pre className="mt-3 overflow-x-auto font-mono text-[12px] leading-[20px] text-ink sm:text-[13px]">
          <code>{s.code}</code>
        </pre>
        {footer && <p className="mt-4 text-[14px] leading-[21px] text-body">{footer}</p>}
        <p aria-live="polite" className="mt-4 min-h-[26px]">
          {copied && (
            <span className="inline-flex items-center gap-2 rounded-[2px] bg-orange-key px-2.5 py-1 font-mono text-[12px] text-ink">
              <span aria-hidden className="size-1.5 rounded-full bg-orange" />
              {agents.copied}
            </span>
          )}
        </p>
      </div>
    </div>
  );
}
