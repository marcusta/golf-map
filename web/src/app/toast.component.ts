import { Component, Signal, template } from '@basics/core/client/core';
import { t } from '../theme';
import { s } from '../css';

export type ToastMessage = {
    text: string;
    /** Short machine detail shown in mono after the text, e.g. an error code. */
    code?: string;
    tone?: 'negative' | 'neutral';
};

/** Default auto-dismiss delay. */
export const TOAST_MS = 5000;

const tpl = template(`
    <div bind="root" class="toast" role="status" aria-live="polite" data-testid="toast">
        <span bind="text" class="toast__text"></span>
        <span bind="code" class="toast__code"></span>
    </div>
`);

/**
 * One transient notice, anchored top-right under the command bar. The owner
 * calls `show()`; a click or the timeout dismisses it. A second `show()`
 * replaces the current message and restarts the timer.
 */
export class ToastComponent extends Component<{ durationMs?: number }> {
    static styles = `
        .toast {
            position: fixed;
            top: calc(58px + ${s('sm')});
            right: ${s('md')};
            z-index: 50;
            display: none;
            align-items: baseline;
            gap: ${s('sm')};
            max-width: 360px;
            padding: ${s('sm')} ${s('md')};
            border: 1px solid ${t('color-border-default')};
            border-radius: 9px;
            background: ${t('color-surface-raised')};
            box-shadow: 0 8px 24px -12px rgba(0, 0, 0, 0.35);
            font-size: 0.82rem;
            color: ${t('color-text-primary')};
            cursor: pointer;
            &.is-open { display: flex; }
            &.tone-negative { border-left: 3px solid ${t('color-status-negative')}; }
            & .toast__code {
                font-family: var(--font-mono);
                font-size: 0.75rem;
                color: ${t('color-text-tertiary')};
                &:empty { display: none; }
            }
        }
    `;

    readonly current = new Signal<ToastMessage | null>(null);
    private timer: ReturnType<typeof setTimeout> | null = null;

    render(): DocumentFragment {
        const frag = this.wire(tpl, {
            root: {
                className: () => {
                    const m = this.current.get();
                    return m ? `toast is-open tone-${m.tone ?? 'neutral'}` : 'toast';
                },
                onclick: () => this.dismiss(),
            },
            text: () => this.current.get()?.text ?? '',
            code: () => this.current.get()?.code ?? '',
        });
        this.track(() => this.clearTimer());
        return frag;
    }

    show(message: ToastMessage): void {
        this.clearTimer();
        this.current.set(message);
        this.timer = setTimeout(() => this.dismiss(), this.props.durationMs ?? TOAST_MS);
    }

    dismiss(): void {
        this.clearTimer();
        this.current.set(null);
    }

    private clearTimer(): void {
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
    }
}
