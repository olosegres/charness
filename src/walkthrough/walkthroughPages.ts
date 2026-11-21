/**
 * The HTML the walkthrough's pictures are drawn from: one frame of the video (the operator's chat columns on the left, «what the agent
 * read» on the right, the steps along the bottom) and one phone-size screenshot (a topic's chat cut at a message). Pure: a string in, a
 * string out; the browser that shoots it is `renderWalkthrough.ts`'s.
 */
import { generalTopicThreadId } from '../__tests__/telegramE2e/fakeTelegram';
import type { StepState, TimedFrame } from './buildWalkthroughFrames';
import { describeAgentCard } from './describeAgentCard';
import type { RecordedMessage, WalkthroughConfig, WalkthroughShot } from './walkthroughTypes';

export const videoWidthPx = 1280;
export const videoHeightPx = 720;
export const phoneWidthPx = 540;
export const phoneHeightPx = 960;

const defaultAgentColumnWidthPx = 400;
const defaultAgentCardsKept = 4;
const defaultHighlightName = 'note';
const visibleMessagesPerColumn = 12;
const topBarHeightPx = 44;
const footerHeightPx = 82;
const columnGapPx = 8;

const fontFamily = "'Inter','Noto Sans','Noto Sans Georgian','Noto Sans Devanagari','Noto Sans CJK JP','Noto Color Emoji',sans-serif";

/** The bot's «setup incomplete» notice in General is noise on a video. */
const setupWarningPrefix = '⚠️ ';

export interface TopicColumn {
  thread: number;
  name: string;
}

/** @description `text` safe to put in HTML. */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** The tags of Telegram's HTML subset the bot sends: the fake Bot API keeps them as typed, Telegram renders them. */
const telegramMarkupTagPattern = /<\/?(?:pre|code|blockquote|b|strong|i|em|u|s|a|tg-spoiler)(?:\s[^>]*)?>/g;

/** @description What a person reads of a message the bot sent: its Telegram HTML without the tags, its entities as the characters they stand for. */
export function getBotMessageDisplayText(text: string): string {
  return text.replace(telegramMarkupTagPattern, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
}

/** @description The columns of the operator's chat: the config's, else one per topic that has a message (`General` for thread 1). */
export function listTopicColumns(messages: readonly RecordedMessage[], config: WalkthroughConfig): TopicColumn[] {
  if (config.topics !== undefined) return config.topics;
  const threads = [...new Set(messages.map((message) => message.thread))].sort((a, b) => a - b);
  return threads.map((thread) => ({ thread, name: thread === generalTopicThreadId ? 'General' : `Topic ${thread}` }));
}

function renderBubble(message: RecordedMessage, tappedData: string | null, isLarge: boolean): string {
  const rows = message.keyboard
    .map((row) => `<div class="row">${row.map((button) => `<div class="button${tappedData !== null && button.data === tappedData ? ' tapped' : ''}">${escapeHtml(button.text)}</div>`).join('')}</div>`)
    .join('');
  const keyboard = rows === '' ? '' : `<div class="keyboard">${rows}</div>`;
  const text = escapeHtml(message.isBot ? getBotMessageDisplayText(message.text) : message.text);
  return `<div class="message ${message.isBot ? 'bot' : 'operator'}${isLarge ? ' large' : ''}"><div class="bubble">${text}</div>${keyboard}</div>`;
}

const sharedCss = `
*{box-sizing:border-box} body{margin:0;background:#0e1621;color:#e8eef5;font-family:${fontFamily};}
.message{display:flex;flex-direction:column;margin:5px 0;max-width:94%}
.message.large{margin:8px 0}
.message.operator{align-self:flex-end;align-items:flex-end}.message.bot{align-self:flex-start;align-items:flex-start}
.bubble{white-space:pre-wrap;word-break:break-word;padding:6px 9px;border-radius:12px;font-size:12.5px;line-height:1.32}
.large .bubble{padding:9px 13px;font-size:16px}
.operator .bubble{background:#2b5278;border-bottom-right-radius:3px}.bot .bubble{background:#182533;border-bottom-left-radius:3px}
.keyboard{width:100%;margin-top:3px}.row{display:flex;gap:3px;margin-top:3px}
.button{flex:1;text-align:center;background:#233549;border-radius:7px;padding:5px 4px;font-size:11.5px;color:#cfe3f7}
.large .button{padding:9px 6px;font-size:15px}
.button.tapped{outline:2px solid #ffb74d;background:#3a4a30}
`;

function renderAgentCards(frame: TimedFrame['frame'], config: WalkthroughConfig): string {
  const kept = frame.agentCards.slice(-(config.agentKeep ?? defaultAgentCardsKept));
  return kept
    .map((event) => {
      const card = describeAgentCard(event, config);
      const words = card.words === '' ? '' : `<div class="words">${escapeHtml(card.words)}</div>`;
      const note = card.note !== null
        ? `<div class="note">${escapeHtml(card.note)}</div>`
        : config.highlightMarker === undefined ? '' : `<div class="none">no ${escapeHtml(config.highlightName ?? defaultHighlightName)}</div>`;
      return `<div class="card"><span class="chip">${escapeHtml(card.label)}</span><span class="kind">${escapeHtml(card.kindText)}</span>${words}${note}</div>`;
    })
    .join('');
}

function renderStepDots(steps: readonly StepState[]): string {
  return steps.map((step) => `<span class="dot ${step.status}"></span>`).join('');
}

/** The step the caption names: the one that runs, else the last one that passed. */
function getCurrentStep(steps: readonly StepState[]): StepState | undefined {
  return steps.find((step) => step.status === 'run') ?? steps.filter((step) => step.status === 'pass').at(-1);
}

/** @description One frame of the video as a page of `videoWidthPx` × `videoHeightPx`. */
export function buildFramePageHtml(input: { timedFrame: TimedFrame; columns: readonly TopicColumn[]; config: WalkthroughConfig; title: string }): string {
  const { timedFrame, columns, config, title } = input;
  const { frame } = timedFrame;
  const agentWidth = config.agentWidth ?? defaultAgentColumnWidthPx;
  const columnWidth = Math.floor((videoWidthPx - agentWidth - columnGapPx * (columns.length + 2)) / columns.length);
  const chatColumns = columns
    .map((column) => {
      const messages = frame.messages.filter((message) => message.thread === column.thread && !(column.thread === generalTopicThreadId && message.text.startsWith(setupWarningPrefix))).slice(-visibleMessagesPerColumn);
      const bubbles = messages.map((message) => renderBubble(message, frame.tapped?.messageId === message.id ? frame.tapped.data : null, false)).join('');
      return `<div class="column" style="width:${columnWidth}px"><div class="column-head">${escapeHtml(column.name)}</div><div class="chat">${bubbles}</div></div>`;
    })
    .join('');
  const passed = frame.steps.filter((step) => step.status === 'pass').length;
  const current = getCurrentStep(frame.steps);
  const wait = timedFrame.waitSeconds === null ? '' : `<span class="wait">⏳ ${timedFrame.waitSeconds} s pass here (shown shortened)</span>`;
  return `<html><head><meta charset="utf-8"><style>${sharedCss}
.top{height:${topBarHeightPx}px;display:flex;align-items:center;justify-content:space-between;padding:0 16px;background:#17212b;font-size:15px;font-weight:600;border-bottom:1px solid #0a1017}
.top small{font-weight:400;color:#8fa3b8}
.main{display:flex;gap:${columnGapPx}px;padding:${columnGapPx}px;height:${videoHeightPx - topBarHeightPx - footerHeightPx}px}
.column{display:flex;flex-direction:column;background:#0e1621;border:1px solid #1d2b3a;border-radius:8px;overflow:hidden}
.column-head{padding:6px 10px;background:#17212b;font-size:13px;font-weight:600;color:#9fb6cc}
.chat{flex:1;display:flex;flex-direction:column;justify-content:flex-end;padding:6px 8px;overflow:hidden}
.agent{width:${agentWidth}px;display:flex;flex-direction:column;background:#101820;border:1px solid #2a3b4d;border-radius:8px;overflow:hidden}
.agent .column-head{color:#ffcc80}.cards{flex:1;display:flex;flex-direction:column;justify-content:flex-end;padding:6px;overflow:hidden;gap:5px}
.card{background:#16222f;border-radius:8px;padding:6px 8px;font-size:11.5px}
.chip{background:#2d4a6b;border-radius:9px;padding:1px 7px;font-weight:600;margin-right:6px}.kind{color:#8fa3b8}
.words{margin-top:3px;color:#cfd8e3}.note{margin-top:4px;background:#4a3a12;border:1px solid #ffb74d;color:#ffe0b2;padding:4px 6px;border-radius:6px;white-space:pre-wrap;word-break:break-word}
.none{margin-top:3px;color:#6b7f93;font-style:italic}
.foot{position:absolute;left:0;right:0;bottom:0;height:${footerHeightPx}px;background:#17212b;border-top:1px solid #0a1017;padding:8px 16px}
.step{font-size:14px;line-height:1.3;color:#e8eef5;max-height:38px;overflow:hidden}.dots{margin-top:6px;display:flex;gap:5px;align-items:center}
.dot{width:12px;height:12px;border-radius:6px;background:#2a3b4d}.dot.pass{background:#4caf50}.dot.run{background:#ffb74d;box-shadow:0 0 0 3px #ffb74d44}.dot.fail{background:#e53935}
.wait{margin-left:14px;color:#ffb74d;font-size:12px}
</style></head><body style="width:${videoWidthPx}px;height:${videoHeightPx}px;position:relative;overflow:hidden">
<div class="top"><div>${escapeHtml(title)}</div><small>${current === undefined ? '' : `step ${current.index}`}</small></div>
<div class="main">${chatColumns}<div class="agent"><div class="column-head">What the agent read — never shown in the topic</div><div class="cards">${renderAgentCards(frame, config)}</div></div></div>
<div class="foot"><div class="step">${current === undefined ? '' : escapeHtml(`${current.index}. ${current.name}`)}</div><div class="dots">${renderStepDots(frame.steps)}<span style="color:#8fa3b8;font-size:11px;margin-left:8px">${passed}/${frame.steps.length} steps passed</span>${wait}</div></div>
</body></html>`;
}

/** @description One phone-size screenshot as a page of `phoneWidthPx` × `phoneHeightPx`: the topic's name on top, `messages` above the caption. */
export function buildShotPageHtml(input: { shot: WalkthroughShot; messages: readonly RecordedMessage[] }): string {
  const { shot, messages } = input;
  const bubbles = messages.map((message) => renderBubble(message, null, true)).join('');
  return `<html><head><meta charset="utf-8"><style>${sharedCss}
body{width:${phoneWidthPx}px;height:${phoneHeightPx}px;display:flex;flex-direction:column;background:#0e1621}
.head{height:58px;background:#17212b;display:flex;align-items:center;padding:0 16px;font-size:18px;font-weight:600;border-bottom:1px solid #0a1017}
.head small{font-weight:400;color:#8fa3b8;margin-left:10px;font-size:13px}
.chat{flex:1;display:flex;flex-direction:column;justify-content:flex-end;padding:10px 12px;background:linear-gradient(#0e1621,#0b121a)}
.caption{padding:8px 14px;font-size:13px;color:#8fa3b8;background:#17212b;border-top:1px solid #0a1017}
</style></head><body><div class="head">${escapeHtml(shot.topicName)}<small>${escapeHtml(shot.subtitle ?? '')}</small></div>
<div class="chat">${bubbles}</div><div class="caption">${escapeHtml(shot.caption)}</div></body></html>`;
}
