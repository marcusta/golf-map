import { Component, Signal, effect, template } from '@basics/core/client/core';
import { t } from '../theme';
import { s, btn, primaryBtn, dangerBtn, panelTitle } from '../css';

export type ConfirmTone = 'danger' | 'primary' | 'warning';
export type ConfirmLayout = 'default' | 'review';

export type ConfirmOptions = {
    title: string;
    body: string;
    detail?: string;
    confirmLabel: string;
    cancelLabel?: string;
    tone?: ConfirmTone;
    layout?: ConfirmLayout;
};

type ConfirmRequest = Required<Omit<ConfirmOptions, 'detail'>> & {
    detail: string;
};

export class ConfirmService {
    readonly current = new Signal<ConfirmRequest | null>(null);
    private resolveCurrent: ((ok: boolean) => void) | null = null;

    confirm(opts: ConfirmOptions): Promise<boolean> {
        this.settle(false);
        const request: ConfirmRequest = {
            title: opts.title,
            body: opts.body,
            detail: opts.detail ?? '',
            confirmLabel: opts.confirmLabel,
            cancelLabel: opts.cancelLabel ?? 'Cancel',
            tone: opts.tone ?? 'danger',
            layout: opts.layout ?? 'default',
        };

        return new Promise<boolean>((resolve) => {
            this.resolveCurrent = resolve;
            this.current.set(request);
        });
    }

    accept(): void {
        this.settle(true);
    }

    cancel(): void {
        this.settle(false);
    }

    private settle(ok: boolean): void {
        const resolve = this.resolveCurrent;
        if (!resolve) return;
        this.resolveCurrent = null;
        this.current.set(null);
        resolve(ok);
    }
}

const tpl = template(`
    <div bind="root" class="confirm-dialog-host" aria-live="polite">
        <div bind="backdrop" class="confirm-dialog-backdrop">
            <section class="confirm-dialog confirm-dialog--default" role="dialog" aria-modal="true" aria-labelledby="confirm-dialog-title-default">
                <div class="confirm-dialog__tone-mark"></div>
                <div bind="defaultIcon" class="confirm-dialog__icon" aria-hidden="true"></div>
                <div class="confirm-dialog__copy">
                    <span bind="defaultEyebrow" class="confirm-dialog__eyebrow"></span>
                    <h2 bind="defaultTitle" id="confirm-dialog-title-default"></h2>
                    <p bind="defaultBody" class="confirm-dialog__body"></p>
                    <p bind="defaultDetail" class="confirm-dialog__detail"></p>
                </div>
                <footer class="confirm-dialog__actions">
                    <button bind="cancelDefault" type="button" class="confirm-dialog__cancel">Cancel</button>
                    <button bind="confirmDefault" type="button" class="confirm-dialog__confirm"></button>
                </footer>
            </section>

            <section class="confirm-dialog confirm-dialog--review" role="dialog" aria-modal="true" aria-labelledby="confirm-dialog-title-review">
                <header class="confirm-dialog__sheet-header">
                    <span bind="reviewEyebrow" class="confirm-dialog__eyebrow"></span>
                    <button bind="closeReview" type="button" class="confirm-dialog__close" aria-label="Cancel">&times;</button>
                </header>
                <div class="confirm-dialog__sheet-body">
                    <h2 bind="reviewTitle" id="confirm-dialog-title-review"></h2>
                    <p bind="reviewBody" class="confirm-dialog__body"></p>
                    <div bind="reviewBox" class="confirm-dialog__review-box">
                        <span>Review</span>
                        <strong bind="reviewDetail"></strong>
                    </div>
                </div>
                <footer class="confirm-dialog__sheet-actions">
                    <button bind="cancelReview" type="button" class="confirm-dialog__cancel">Cancel</button>
                    <button bind="confirmReview" type="button" class="confirm-dialog__confirm"></button>
                </footer>
            </section>
        </div>
    </div>
`);

type ConfirmDialogProps = {
    service?: ConfirmService;
};

export class ConfirmDialogComponent extends Component<ConfirmDialogProps> {
    static styles = `
        .confirm-dialog-host {
            position: fixed;
            inset: 0;
            z-index: 1000;
            display: none;
            color: ${t('color-text-primary')};
            pointer-events: none;

            &.is-open {
                display: block;
                pointer-events: auto;
            }

            & .confirm-dialog-backdrop {
                position: absolute;
                inset: 0;
                background: ${t('overlay-scrim')};
                backdrop-filter: blur(6px);
                -webkit-backdrop-filter: blur(6px);
            }

            & .confirm-dialog {
                border: 1px solid ${t('color-border-subtle')};
                border-radius: var(--radius-lg);
                background: ${t('color-surface-card')};
                box-shadow: var(--elev-3);
            }

            & h2 {
                margin: ${s('xs')} 0 0;
                font-size: 1.12rem;
                line-height: 1.22;
                letter-spacing: 0;
            }

            & .confirm-dialog__eyebrow {
                ${panelTitle()}
            }

            & .confirm-dialog__body {
                margin: ${s('sm')} 0 0;
                color: ${t('color-text-primary')};
                font-size: 0.91rem;
                line-height: 1.48;
            }

            & .confirm-dialog__detail {
                margin: ${s('sm')} 0 0;
                color: ${t('color-text-secondary')};
                font-size: 0.82rem;
                line-height: 1.45;
            }

            & .confirm-dialog__actions,
            & .confirm-dialog__sheet-actions {
                display: flex;
                justify-content: flex-end;
                gap: ${s('sm')};
            }

            & .confirm-dialog__cancel,
            & .confirm-dialog__confirm,
            & .confirm-dialog__close {
                font: inherit;
                cursor: pointer;
            }

            & .confirm-dialog__cancel {
                ${btn()}
                height: 36px;
                padding: 0 ${s('lg')};
                font-size: 0.84rem;
                font-weight: 600;
            }

            & .confirm-dialog__confirm {
                ${primaryBtn()}
                height: 36px;
                padding: 0 ${s('lg')};
                font-size: 0.84rem;
                font-weight: 700;
            }

            &.tone-danger .confirm-dialog__confirm {
                ${dangerBtn()}
                height: 36px;
                padding: 0 ${s('lg')};
                font-size: 0.84rem;
            }
            &.tone-warning .confirm-dialog__confirm {
                border: 1px solid color-mix(in srgb, ${t('color-status-caution')} 30%, transparent);
                background: color-mix(in srgb, ${t('color-status-caution')} 12%, transparent);
                color: ${t('color-status-caution')};
            }
            &.tone-danger .confirm-dialog__tone-mark,
            &.tone-danger .confirm-dialog__icon { background: ${t('color-status-negative')}; }
            &.tone-warning .confirm-dialog__tone-mark,
            &.tone-warning .confirm-dialog__icon { background: ${t('color-status-caution')}; }
            &.tone-primary .confirm-dialog__tone-mark,
            &.tone-primary .confirm-dialog__icon { background: ${t('color-accent-primary')}; }

            & .confirm-dialog--default {
                position: absolute;
                top: 50%;
                left: 50%;
                display: none;
                width: min(440px, calc(100vw - 48px));
                padding: ${s('xl')};
                overflow: hidden;
                transform: translate(-50%, -50%);
            }

            &.layout-default .confirm-dialog--default { display: block; }

            & .confirm-dialog--default .confirm-dialog__tone-mark {
                position: absolute;
                inset: 0 auto 0 0;
                width: 4px;
            }

            & .confirm-dialog__icon {
                width: 36px;
                height: 36px;
                margin-bottom: ${s('sm')};
                border-radius: 50%;
            }

            & .confirm-dialog__actions {
                margin-top: ${s('xl')};
            }

            & .confirm-dialog--review {
                position: absolute;
                top: 0;
                right: 0;
                bottom: 0;
                display: none;
                width: min(440px, 92vw);
                padding: ${s('xl')};
                border-top-right-radius: 0;
                border-bottom-right-radius: 0;
            }

            &.layout-review .confirm-dialog--review { display: block; }

            & .confirm-dialog__sheet-header {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: ${s('md')};
            }

            & .confirm-dialog__close {
                width: 32px;
                height: 32px;
                border: 1px solid ${t('color-border-default')};
                border-radius: 50%;
                background: ${t('color-surface-card')};
                color: ${t('color-text-secondary')};
                font-size: 1.2rem;
                line-height: 1;
            }

            & .confirm-dialog__close:hover {
                background: ${t('color-surface-sunken')};
                color: ${t('color-text-primary')};
            }

            & .confirm-dialog__sheet-body {
                display: flex;
                flex-direction: column;
                gap: ${s('md')};
                margin-top: ${s('xl')};
            }

            & .confirm-dialog__review-box {
                display: flex;
                flex-direction: column;
                gap: ${s('xs')};
                margin-top: ${s('sm')};
                padding: ${s('md')};
                border: 1px solid ${t('color-border-default')};
                border-radius: ${t('radius')};
                background: ${t('color-surface-app')};
            }

            & .confirm-dialog__review-box span {
                ${panelTitle()}
            }

            & .confirm-dialog__review-box strong {
                font-size: 0.86rem;
                line-height: 1.45;
            }

            & .confirm-dialog__sheet-actions {
                position: absolute;
                right: ${s('xl')};
                bottom: ${s('xl')};
                left: ${s('xl')};
            }

            @media (max-width: 560px) {
                & .confirm-dialog--review {
                    left: 0;
                    width: auto;
                    border-radius: 0;
                }

                & .confirm-dialog__sheet-actions {
                    flex-direction: column-reverse;
                }

                & .confirm-dialog__sheet-actions button {
                    width: 100%;
                }
            }
        }
    `;

    private svc = this.props.service ?? this.inject(ConfirmService);
    private cancelDefault!: HTMLButtonElement;
    private cancelReview!: HTMLButtonElement;
    private confirmDefault!: HTMLButtonElement;
    private confirmReview!: HTMLButtonElement;

    render(): DocumentFragment {
        const request = () => this.svc.current.get();
        const title = () => request()?.title ?? '';
        const body = () => request()?.body ?? '';
        const detail = () => request()?.detail ?? '';
        const confirmLabel = () => request()?.confirmLabel ?? '';
        const cancelLabel = () => request()?.cancelLabel ?? 'Cancel';
        const eyebrow = () => {
            const tone = request()?.tone ?? 'danger';
            if (tone === 'primary') return 'Device sync';
            if (tone === 'warning') return 'One-way edit';
            return 'Destructive action';
        };

        const frag = this.wire(tpl, {
            root: {
                className: () => {
                    const current = request();
                    return current
                        ? `confirm-dialog-host is-open layout-${current.layout} tone-${current.tone}`
                        : 'confirm-dialog-host';
                },
            },
            backdrop: {
                onclick: (e: Event) => {
                    if (e.target === e.currentTarget) this.svc.cancel();
                },
            },
            defaultIcon: {},
            defaultEyebrow: eyebrow,
            reviewEyebrow: eyebrow,
            defaultTitle: title,
            reviewTitle: title,
            defaultBody: body,
            reviewBody: body,
            defaultDetail: {
                textContent: detail,
                style: () => detail() ? '' : 'display:none',
            },
            reviewBox: { style: () => detail() ? '' : 'display:none' },
            reviewDetail: detail,
            cancelDefault: {
                textContent: cancelLabel,
                onclick: () => this.svc.cancel(),
            },
            cancelReview: {
                textContent: cancelLabel,
                onclick: () => this.svc.cancel(),
            },
            closeReview: { onclick: () => this.svc.cancel() },
            confirmDefault: {
                textContent: confirmLabel,
                onclick: () => this.svc.accept(),
            },
            confirmReview: {
                textContent: confirmLabel,
                onclick: () => this.svc.accept(),
            },
        });

        this.cancelDefault = this.ref(frag, 'cancelDefault') as HTMLButtonElement;
        this.cancelReview = this.ref(frag, 'cancelReview') as HTMLButtonElement;
        this.confirmDefault = this.ref(frag, 'confirmDefault') as HTMLButtonElement;
        this.confirmReview = this.ref(frag, 'confirmReview') as HTMLButtonElement;

        this.track(effect(() => {
            const current = this.svc.current.get();
            if (!current) return;
            requestAnimationFrame(() => {
                if (current.layout === 'review') this.cancelReview.focus();
                else if (current.tone === 'danger') this.cancelDefault.focus();
                else this.confirmDefault.focus();
            });
        }));

        const onKeyDown = (e: KeyboardEvent) => {
            if (!this.svc.current.peek()) return;
            if (e.key === 'Escape') {
                e.preventDefault();
                this.svc.cancel();
            } else if (e.key === 'Enter') {
                e.preventDefault();
                this.svc.accept();
            }
        };
        window.addEventListener('keydown', onKeyDown);
        this.track(() => window.removeEventListener('keydown', onKeyDown));

        return frag;
    }
}
