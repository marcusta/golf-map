import { Component, Router, template } from '@basics/core/client/core';
import { AuthService } from '@basics/core/client/auth';
import { t } from '../theme';
import { s } from '../css';
import { LoginComponent } from '../auth/login.component';
import { CourseListComponent } from '../courses/course-list.component';
import { CourseDetailComponent } from '../course-detail/course-detail.component';
import { PlannerComponent } from '../planner/planner.component';
import { PlayerSettingsComponent } from '../player/player-settings.component';
import { NewCourseWizardComponent } from '../map-build/new-course-wizard.component';
import { SetMapAreaComponent } from '../map-build/set-map-area.component';
import { ConfirmDialogComponent } from './confirm-dialog.component';
import { icon } from '../ui/icons';

const tpl = template(`
    <div bind="layout" class="app-layout">
        <header bind="topbar" class="topbar">
            <a bind="homeLink" href="/">${icon('flag', 20)} Golf Map</a>
            <span class="topbar__spacer"></span>
            <a bind="playerLink" href="/player" class="topbar__player">Player</a>
            <span bind="username" class="topbar__user"></span>
            <button bind="logout" class="topbar__logout">Log out</button>
        </header>
        <main bind="content" class="app-content"></main>
        <div bind="confirmHost"></div>
    </div>
`);

export class AppComponent extends Component {
    static styles = `
        .app-layout {
            display: flex;
            flex-direction: column;
            height: 100vh;
            background: ${t('color-surface-app')};
        }

        .topbar {
            display: flex;
            align-items: center;
            gap: ${s('md')};
            height: 48px;
            flex-shrink: 0;
            padding: 0 ${s('lg')};
            background: ${t('color-surface-brand')};
            border-bottom: 1px solid ${t('color-border-default')};

            /* router.link() drives className, so the logo <a> is styled via
               the parent selector rather than a class of its own. The
               topbar sits on color-surface-brand, a permanently dark pine
               chrome that does NOT flip with the theme (same hex in both
               light and dark). color-text-inverse would invert the wrong
               way here (it goes dark-on-dark in dark mode), so the topbar
               reads off the overlay tokens instead — the only tokens in
               the palette built to stay light-on-dark-chrome regardless
               of theme (same contract as text over the map). */
            & > a {
                display: inline-flex;
                align-items: center;
                gap: ${s('xs')};
                font-size: 1rem;
                font-weight: 700;
                color: ${t('overlay-text')};
                text-decoration: none;
            }

            & .topbar__spacer { flex: 1; }

            & .topbar__user {
                font-size: 0.8rem;
                color: ${t('overlay-text-muted')};
            }

            & .topbar__player {
                font-size: 0.8rem;
                font-weight: 400;
                color: ${t('overlay-text-muted')};
                text-decoration: none;
                padding: ${s('xs')} ${s('md')};
                border: 1px solid transparent;
                border-radius: ${t('radius-pill')};
                transition: border-color var(--dur-fast) var(--ease-standard),
                    color var(--dur-fast) var(--ease-standard);
                &:hover { border-color: ${t('overlay-text-muted')}; color: ${t('overlay-text')}; }
            }

            & .topbar__logout {
                padding: ${s('xs')} ${s('md')};
                font-size: 0.8rem;
                border: 1px solid transparent;
                border-radius: ${t('radius-pill')};
                background: transparent;
                color: ${t('overlay-text-muted')};
                cursor: pointer;
                transition: border-color var(--dur-fast) var(--ease-standard),
                    color var(--dur-fast) var(--ease-standard);
                &:hover { border-color: ${t('overlay-text-muted')}; color: ${t('overlay-text')}; }
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
        // The unified command bar (command-bar.component.ts) IS the header on
        // the course/planner routes, so the global topbar is chromeless there
        // (same mechanism as /login) — it stays only on the courses list,
        // player settings and the map-build wizard routes.
        const chromeless = () => {
            const route = this.router.route.get();
            return route === '/login' || route.startsWith('/course') || route.startsWith('/planner');
        };

        const frag = this.wire(tpl, {
            topbar: {
                style: () => chromeless() ? 'display:none' : '',
            },
            homeLink: this.router.link('/'),
            // Manual navigate (not router.link) — link() drives className,
            // which would clobber the styling class on this anchor.
            playerLink: {
                onclick: (e: Event) => {
                    e.preventDefault();
                    this.router.navigate('/player');
                },
                style: () => chromeless() ? 'display:none' : '',
            },
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
            '/new': NewCourseWizardComponent,
            '/set-area': SetMapAreaComponent,
            '/course': CourseDetailComponent,
            '/planner': PlannerComponent,
            '/player': PlayerSettingsComponent,
            '/login': LoginComponent,
        }, CourseListComponent);

        this.spawn(ConfirmDialogComponent, this.ref(frag, 'confirmHost'));

        return frag;
    }
}
