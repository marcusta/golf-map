import { Component, Router, template } from '@basics/core/client/core';
import { AuthService } from '@basics/core/client/auth';
import { t } from '../../theme';
import { s, card, field, primaryBtn } from '../../css';
import { icon } from '../../ui/icons';
import { MOBILE_ROOT } from '../guard';

const tpl = template(`
    <div class="m-login" bind="root">
        <div class="m-login__card">
            <h1 class="m-login__title">${icon('flag', 24)} Golf Map</h1>
            <p class="m-login__subtitle">On the course</p>
            <div class="m-login__error" bind="error"></div>
            <form bind="form" class="m-login__form">
                <label>Username
                    <input bind="username" type="text" autocomplete="username" autocapitalize="none" autocorrect="off" />
                </label>
                <label>Password
                    <input bind="password" type="password" autocomplete="current-password" />
                </label>
                <button type="submit" bind="submit" data-testid="m-login-submit">Sign in</button>
            </form>
        </div>
    </div>
`);

/**
 * Mobile login. Reuses AuthService (the shared cookie session works as-is on
 * Safari), differing from the desktop LoginComponent only in navigating into
 * the mobile route tree on success and in touch-target sizing.
 */
export class MobileLoginComponent extends Component {
    static styles = `
        .m-login {
            display: flex;
            align-items: center;
            justify-content: center;
            min-height: 100%;
            padding: calc(${s('xl')} + var(--safe-top)) ${s('lg')} calc(${s('xl')} + var(--safe-bottom));
            background: ${t('color-surface-app')};

            &[inert] { opacity: 0.6; }

            & .m-login__card {
                width: 100%;
                max-width: 420px;
                padding: ${s('2xl')};
                ${card()}
            }

            & .m-login__title {
                margin: 0;
                font-size: 1.6rem;
                color: ${t('color-accent-primary')};
                text-align: center;
            }

            & .m-login__subtitle {
                margin: ${s('xs')} 0 ${s('xl')};
                font-size: 0.95rem;
                color: ${t('color-text-secondary')};
                text-align: center;
            }

            & .m-login__error {
                display: none;
                padding: ${s('sm')} ${s('md')};
                margin-bottom: ${s('md')};
                color: ${t('color-status-negative')};
                font-size: 0.9rem;
                border-radius: ${t('radius-sm')};
                background: color-mix(in srgb, ${t('color-status-negative')} 8%, transparent);
            }
            & .m-login__error.show { display: block; }

            & .m-login__form {
                display: flex;
                flex-direction: column;
                gap: ${s('lg')};

                & label { ${field()} }

                /* 16px input font stops iOS Safari zoom-on-focus; 48px min
                   height keeps touch targets comfortable. */
                & input {
                    min-height: 48px;
                    font-size: 1rem !important;
                }

                & button {
                    min-height: 48px;
                    font-size: 1rem;
                    ${primaryBtn()}
                }
            }
        }
    `;

    private auth = this.inject(AuthService);
    private router = this.inject(Router);
    private username = '';
    private password = '';

    render(): DocumentFragment {
        return this.wire(tpl, {
            root: { inert: () => this.auth.loading.get() },
            error: {
                className: () => this.auth.error.get() ? 'm-login__error show' : 'm-login__error',
                textContent: () => this.auth.error.get()?.message ?? '',
            },
            form: {
                onsubmit: async (e: Event) => {
                    e.preventDefault();
                    const ok = await this.auth.login(this.username, this.password);
                    if (ok) this.router.navigate(MOBILE_ROOT, true);
                },
            },
            username: {
                oninput: (e: Event) => { this.username = (e.target as HTMLInputElement).value; },
            },
            password: {
                oninput: (e: Event) => { this.password = (e.target as HTMLInputElement).value; },
            },
            submit: {
                textContent: () => this.auth.loading.get() ? 'Signing in...' : 'Sign in',
            },
        });
    }
}
