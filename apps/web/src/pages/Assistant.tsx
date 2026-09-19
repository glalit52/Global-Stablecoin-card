import { useEffect, useRef, useState } from 'react';
import { api, ApiError, dateTime } from '../lib/api';
import type { AiAnswer } from '../lib/types';
import { Card, ErrorText } from '../components/ui';
import { PageHead } from '../components/Layout';

interface Turn {
  question: string;
  answer: AiAnswer | null;
  error?: string;
}

export const Assistant = () => {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [question, setQuestion] = useState('');
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [openSources, setOpenSources] = useState<number | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void (async () => {
      const res = await api.get<{ suggestions: string[] }>('/v1/ai/suggestions');
      setSuggestions(res.suggestions);
    })();
  }, []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [turns]);

  const ask = async (text: string) => {
    if (!text.trim() || busy) return;
    setBusy(true);
    setError('');
    setTurns((t) => [...t, { question: text, answer: null }]);
    setQuestion('');
    try {
      const answer = await api.post<AiAnswer>('/v1/ai/query', { question: text });
      setTurns((t) => {
        const next = [...t];
        next[next.length - 1] = { question: text, answer };
        return next;
      });
    } catch (err) {
      const message = err instanceof ApiError ? err.message : 'Could not reach the assistant';
      setTurns((t) => {
        const next = [...t];
        next[next.length - 1] = { question: text, answer: null, error: message };
        return next;
      });
      setError(message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHead
        title="Assistant"
        sub="Every figure comes from your account, with its source and timestamp attached."
      />

      <Card>
        <div className="chat" style={{ minHeight: 340 }}>
          {turns.length === 0 && (
            <div className="bubble bubble-agent">
              I can explain your credit limit and why it changed, your collateral health and
              concentration, how much you can safely spend, what a specific purchase would do,
              your repayment options, and how you would fare in a downturn.
              <div className="sources">
                I only state figures I can source from your account. If I cannot ground a number,
                I leave it out rather than estimate it — and I do not give investment advice.
              </div>
            </div>
          )}

          {turns.map((turn, i) => (
            <div key={i} style={{ display: 'contents' }}>
              <div className="bubble bubble-user">{turn.question}</div>
              {turn.answer ? (
                <div className="bubble bubble-agent">
                  {turn.answer.answer}

                  {turn.answer.groundingRejected && (
                    <div className="sources" style={{ color: 'var(--watch)' }}>
                      Part of this explanation was withheld because some figures in it could not be
                      matched against current account data.
                    </div>
                  )}

                  <div className="sources">
                    <button
                      className="btn btn-sm"
                      style={{ marginBottom: openSources === i ? 10 : 0 }}
                      onClick={() => setOpenSources(openSources === i ? null : i)}
                      aria-expanded={openSources === i}
                    >
                      {openSources === i ? 'Hide' : 'Show'} {turn.answer.sources.length} sources
                    </button>

                    {openSources === i && (
                      <div>
                        {turn.answer.sources.map((s) => (
                          <div key={s.key} className="source-item">
                            <span>{s.label}</span>
                            <span className="mono">
                              {s.value}{s.unit === 'percent' ? '%' : ''}
                              <span className="dim"> · {dateTime(s.asOf)} · {s.source}</span>
                            </span>
                          </div>
                        ))}
                      </div>
                    )}

                    {turn.answer.disclaimers.map((d, j) => (
                      <div key={j} style={{ marginTop: 6 }}>{d}</div>
                    ))}
                  </div>
                </div>
              ) : turn.error ? (
                <div className="bubble bubble-agent error-text">{turn.error}</div>
              ) : (
                <div className="bubble bubble-agent">
                  <span className="dim">Working through your account…</span>
                </div>
              )}
            </div>
          ))}
          <div ref={endRef} />
        </div>

        {suggestions.length > 0 && turns.length === 0 && (
          <div className="chips mt">
            {suggestions.map((s) => (
              <button key={s} className="chip" onClick={() => void ask(s)}>{s}</button>
            ))}
          </div>
        )}

        <form
          className="row mt"
          onSubmit={(e) => { e.preventDefault(); void ask(question); }}
        >
          <input
            className="input"
            placeholder="Ask about your limit, collateral, spending or risk…"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            disabled={busy}
            aria-label="Your question"
          />
          <button className="btn btn-primary" disabled={busy || !question.trim()}>
            {busy ? 'Thinking…' : 'Ask'}
          </button>
        </form>
        <ErrorText>{error}</ErrorText>
      </Card>
    </>
  );
};
