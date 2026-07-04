import { Component, Router, template } from '@basics/core/client/core';
import { AuthService } from '@basics/core/client/auth';
import { t } from '../theme';
import { s, card, field, primaryBtn } from '../css';

const tpl = template(`
    <div class="login" bind="root">
        <div class="login__card">
            <h1 class="login__title">&#9971; Golf Map</h1>
            <p class="login__subtitle">Course Builder</p>
            <div class="error" bind="error"></div>
            <form bind="form" class="login__form">
                <label>Username
                    <input bind="username" type="text" autocomplete="username" />
                </label>
                <label>Password
                    <input bind="password" type="password" autocomplete="current-password" />
                </label>
                <button type="submit" bind="submit">Sign in</button>
            </form>
        </div>
    </div>
`);

export class LoginComponent extends Component {
    static styles = `
        .login {
            display: flex;
            align-items: center;
            justify-content: center;
            height: 100%;
            background: ${t('bg')};

            &[inert] { opacity: 0.6; }

            & .login__card {
                width: 100%;
                max-width: 380px;
                padding: ${s('2xl')};
                ${card()}
            }

            & .login__title {
                margin: 0;
                font-size: 1.5rem;
                color: ${t('primary')};
                text-align: center;
            }

            & .login__subtitle {
                margin: ${s('xs')} 0 ${s('xl')};
                font-size: 0.875rem;
                color: ${t('text-muted')};
                text-align: center;
            }

            & .error {
                display: none;
                padding: ${s('sm')} ${s('md')};
                margin-bottom: ${s('md')};
                color: ${t('error')};
                font-size: 0.875rem;
                border-radius: ${t('radius-sm')};
                background: rgba(201, 42, 42, 0.08);
            }
            & .error.show {
                display: block;
            }

            & .login__form {
                display: flex;
                flex-direction: column;
                gap: ${s('md')};

                & label { ${field()} }

                & button {
                    padding: ${s('sm')} ${s('lg')};
                    font-size: 0.875rem;
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
                className: () => this.auth.error.get() ? 'error show' : 'error',
                textContent: () => this.auth.error.get()?.message ?? '',
            },
            form: {
                onsubmit: async (e: Event) => {
                    e.preventDefault();
                    const ok = await this.auth.login(this.username, this.password);
                    if (ok) this.router.navigate('/', true);
                },
            },
            username: {
                oninput: (e: Event) => {
                    this.username = (e.target as HTMLInputElement).value;
                },
            },
            password: {
                oninput: (e: Event) => {
                    this.password = (e.target as HTMLInputElement).value;
                },
            },
            submit: {
                textContent: () => this.auth.loading.get() ? 'Signing in...' : 'Sign in',
            },
        });
    }
}
