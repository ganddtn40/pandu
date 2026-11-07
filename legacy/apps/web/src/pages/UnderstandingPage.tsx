import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import { EmptyState, ErrorBanner, LoadingRows } from '../components/Messages';
import { formatDateTime, formatNumber, formatRelativeTime } from '../lib/format';
import { usePageTitle, useUnderstandingDetail } from '../lib/hooks';

function StatusPill({ status }: { status: string }) {
  return <span className={`status-chip debt-chip-${status}`}>{status}</span>;
}

export function UnderstandingPage() {
  const { id = '' } = useParams<{ id: string }>();
  const detail = useUnderstandingDetail(id);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  usePageTitle('Understanding · Cockpit');

  const file = detail.detail?.file;
  const quiz = detail.quiz;
  const result = detail.quizResult;
  const answered = quiz
    ? quiz.questions.every((question) => answers[question.id] !== undefined)
    : false;

  return (
    <div className="page page-understanding">
      <div className="detail-top">
        <Link className="back-link" to="/debt">
          <span aria-hidden="true">←</span> Understanding debt
        </Link>
        <div className="detail-actions">
          <button
            className="ghost-button button-small"
            type="button"
            onClick={() => void detail.open()}
            disabled={detail.busy !== null}
          >
            {detail.busy === 'open' ? 'Opening…' : 'Mark opened'}
          </button>
          <button
            className="ghost-button button-small"
            type="button"
            onClick={() => void detail.acknowledge()}
            disabled={detail.busy !== null || file?.status === 'acknowledged'}
          >
            {detail.busy === 'acknowledge' ? 'Acknowledging…' : 'Acknowledge'}
          </button>
          <button
            className="ghost-button button-small"
            type="button"
            onClick={() => void detail.explain()}
            disabled={detail.busy !== null}
          >
            {detail.busy === 'explain' ? 'Explaining…' : 'Explain'}
          </button>
        </div>
      </div>

      {detail.error ? (
        <ErrorBanner message={detail.error} onRetry={detail.refresh} retrying={detail.loading} />
      ) : null}
      {detail.actionError ? (
        <ErrorBanner message={detail.actionError} onRetry={detail.refresh} />
      ) : null}

      {detail.loading && !file ? <LoadingRows rows={2} label="Loading understanding file" /> : null}

      {file ? (
        <>
          <header className="page-head">
            <p className="eyebrow">
              <span className="eyebrow-line" aria-hidden="true" />
              Understanding · <span className="mono detail-id">{file.id}</span>
            </p>
            <h1 className="understanding-title">
              <span className="mono">{file.path}</span>
            </h1>
            <p className="page-lede">
              {formatNumber(file.aiLines)} AI-attributed lines · {formatNumber(file.reviewedLines)}{' '}
              reviewed · score {file.fileScore}/100 · <StatusPill status={file.status} />
            </p>
          </header>

          <section className="panel" aria-labelledby="explain-title">
            <div className="panel-head">
              <div>
                <p className="panel-kicker">Deterministic explanation</p>
                <h2 id="explain-title">What changed and why it matters</h2>
              </div>
              <button
                className="ghost-button button-small"
                type="button"
                onClick={() => void detail.explain()}
                disabled={detail.busy !== null}
              >
                {detail.busy === 'explain' ? 'Working…' : 'Generate'}
              </button>
            </div>
            {detail.explanation ? (
              <div className="understanding-explanation">
                {detail.explanation
                  .split('\n')
                  .map((line, index) =>
                    line.length === 0 ? (
                      <br key={`gap-${String(index)}`} />
                    ) : (
                      <p key={`line-${String(index)}`}>{line}</p>
                    ),
                  )}
              </div>
            ) : (
              <EmptyState title="No explanation yet">
                <p>
                  Cockpit can summarize the recorded provenance without calling a model. Generate it
                  to see which prompts produced these lines.
                </p>
              </EmptyState>
            )}
          </section>

          <section className="panel" aria-labelledby="provenance-title">
            <div className="panel-head">
              <div>
                <p className="panel-kicker">Attribution</p>
                <h2 id="provenance-title">Provenance ranges</h2>
              </div>
              <span className="count-chip">{detail.detail?.provenance.length ?? 0}</span>
            </div>
            {!detail.detail || detail.detail.provenance.length === 0 ? (
              <EmptyState title="No ranges recorded">
                <p>Provenance is captured from the diffs in each step&apos;s git snapshot.</p>
              </EmptyState>
            ) : (
              <ul className="provenance-list">
                {detail.detail.provenance.map((entry) => (
                  <li key={entry.id}>
                    <div className="provenance-head">
                      <span className="mono">
                        lines {entry.lineStart}–{entry.lineEnd}
                      </span>
                      <span className="provenance-meta">
                        {entry.model ?? 'unknown model'} · {entry.provider ?? 'unknown provider'} ·{' '}
                        {formatDateTime(entry.capturedAt)}
                      </span>
                    </div>
                    {entry.promptExcerpt ? (
                      <p className="provenance-prompt">&ldquo;{entry.promptExcerpt}&rdquo;</p>
                    ) : null}
                    <p className="provenance-hash mono">sha256 {entry.contentHash.slice(0, 16)}…</p>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="panel" aria-labelledby="quiz-title">
            <div className="panel-head">
              <div>
                <p className="panel-kicker">Comprehension</p>
                <h2 id="quiz-title">Can you explain it back?</h2>
              </div>
              {quiz ? null : (
                <button
                  className="ghost-button button-small"
                  type="button"
                  onClick={() => void detail.startQuiz()}
                  disabled={detail.busy !== null}
                >
                  {detail.busy === 'quiz' ? 'Preparing…' : 'Start quiz'}
                </button>
              )}
            </div>

            {result ? (
              <div className="quiz-result">
                <p className="quiz-score">
                  {result.correctCount}/{result.total} correct · {Math.round(result.score * 100)}%
                </p>
                <ol className="quiz-answer-list">
                  {result.results.map((answer) => (
                    <li
                      key={answer.questionId}
                      className={answer.correct ? 'is-correct' : 'is-wrong'}
                    >
                      <span className="quiz-answer-mark" aria-hidden="true">
                        {answer.correct ? '✓' : '✗'}
                      </span>
                      <div>
                        <p className="mono">
                          chose {answer.choiceId} · correct {answer.correctChoiceId}
                        </p>
                        <p>{answer.explanation}</p>
                      </div>
                    </li>
                  ))}
                </ol>
                <button
                  className="ghost-button button-small"
                  type="button"
                  onClick={() => {
                    setAnswers({});
                    void detail.startQuiz();
                  }}
                  disabled={detail.busy !== null}
                >
                  New quiz
                </button>
              </div>
            ) : quiz ? (
              <form
                className="quiz-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void detail.submitQuiz({
                    answers: quiz.questions.map((question) => ({
                      questionId: question.id,
                      choiceId: answers[question.id] ?? '',
                    })),
                  });
                }}
              >
                {quiz.questions.map((question, index) => (
                  <fieldset className="quiz-question" key={question.id}>
                    <legend>
                      {index + 1}. {question.prompt}
                    </legend>
                    {question.choices.map((choice) => (
                      <label className="quiz-choice" key={choice.id}>
                        <input
                          type="radio"
                          name={question.id}
                          value={choice.id}
                          checked={answers[question.id] === choice.id}
                          onChange={() =>
                            setAnswers((previous) => ({
                              ...previous,
                              [question.id]: choice.id,
                            }))
                          }
                        />
                        <span className="quiz-choice-id mono">{choice.id}</span>
                        <span>{choice.text}</span>
                      </label>
                    ))}
                  </fieldset>
                ))}
                <button
                  className="primary-button"
                  type="submit"
                  disabled={!answered || detail.busy !== null}
                >
                  {detail.busy === 'submit' ? 'Scoring…' : 'Submit answers'}
                </button>
              </form>
            ) : (
              <EmptyState title="No quiz yet">
                <p>
                  Quizzes are generated from the recorded provenance. They test whether you know
                  what changed, not whether you can guess a model&apos;s opinion.
                </p>
              </EmptyState>
            )}
          </section>

          <section className="panel" aria-labelledby="history-title">
            <div className="panel-head">
              <div>
                <p className="panel-kicker">History</p>
                <h2 id="history-title">Review trail</h2>
              </div>
            </div>
            {detail.detail && detail.detail.events.length > 0 ? (
              <ul className="understanding-events">
                {detail.detail.events.map((event) => (
                  <li key={event.id}>
                    <span className="mono">{event.type}</span>
                    <span>{formatRelativeTime(event.occurredAt)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState title="Nothing recorded yet">
                <p>
                  Opening, acknowledging, explaining, and quizzes all leave an audit trail here.
                </p>
              </EmptyState>
            )}
          </section>
        </>
      ) : null}
    </div>
  );
}
