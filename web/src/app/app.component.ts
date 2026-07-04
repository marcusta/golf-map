import { Component, Router, template } from '@basics/core/client/core';
import { AuthService } from '@basics/core/client/auth';
import { t } from '../theme';
import { s } from '../css';
import { LoginComponent } from '../auth/login.component';
import { CourseListComponent } from '../courses/course-list.component';
import { CourseDetailComponent } from '../course-detail/course-detail.component';

const tpl = template(`
    <div bind="layout" class="app-layout">
        <header bind="topbar" class="topbar">
            <a bind="homeLink" href="/">&#9971; Golf Map</a>
            <span class="topbar__spacer"></span>
            <span bind="username" class="topbar__user"></span>
            <button bind="logout" class="topbar__logout">Log out</button>
        </header>
        <main bind="content" class="app-content"></main>
    </div>
`);

export class AppComponent extends Component {
    static styles = `
        .app-layout {
            display: flex;
            flex-direction: column;
            height: 100vh;
            background: ${t('bg')};
        }

        .topbar {
            display: flex;
            align-items: center;
            gap: ${s('md')};
            height: 48px;
            flex-shrink: 0;
            padding: 0 ${s('lg')};
            background: ${t('topbar-bg')};
            border-bottom: 1px solid ${t('border')};

            /* router.link() drives className, so the logo <a> is styled via
               the parent selector rather than a class of its own. */
            & > a {
                font-size: 1rem;
                font-weight: 700;
                color: ${t('topbar-logo')};
                text-decoration: none;
            }

            & .topbar__spacer { flex: 1; }

            & .topbar__user {
                font-size: 0.8rem;
                color: ${t('topbar-logo')};
            }

            & .topbar__logout {
                padding: ${s('xs')} ${s('md')};
                font-size: 0.8rem;
                border: 1px solid transparent;
                border-radius: ${t('radius-pill')};
                background: transparent;
                color: ${t('topbar-logo')};
                cursor: pointer;
                transition: border-color 0.15s, color 0.15s;
                &:hover { border-color: ${t('topbar-logo')}; }
            }
        }

        .app-content {
            flex: 1;
            min-height: 0;
            overflow: hidden;
        }
    `;

    private auth = this.inject(AuthService);
    private router = this.inject(Router);

    render(): DocumentFragment {
        const isLogin = () => this.router.route.get() === '/login';

        const frag = this.wire(tpl, {
            topbar: {
                style: () => isLogin() ? 'display:none' : '',
            },
            homeLink: this.router.link('/'),
            username: () => this.auth.currentUser.get()?.username ?? '',
            logout: {
                onclick: async () => {
                    await this.auth.logout();
                    this.router.navigate('/login', true);
                },
            },
        });

        this.$swap(this.ref(frag, 'content'), this.router.route, {
            '/': CourseListComponent,
            '/course': CourseDetailComponent,
            '/login': LoginComponent,
        }, CourseListComponent);

        return frag;
    }
}
