import { Component, Router, template } from '@basics/core/client/core';
import { t } from '../../theme';
import { MobileLoginComponent } from './mobile-login.component';
import { MobileCourseListComponent } from '../course/mobile-course-list.component';
import { MobileHoleComponent } from '../course/mobile-hole.component';

const tpl = template(`
    <div bind="root" class="m-app"></div>
`);

/**
 * Mobile companion shell: a single fullscreen host that swaps between the
 * login, course-list and hole screens by route. There is no persistent
 * topbar — chrome is per-screen (the hole screen is edge-to-edge map with
 * floating overlays), mirroring how the desktop app goes chromeless on the
 * editor routes.
 *
 * Route table (see mobile/guard.ts + main.ts):
 *   /m               → course list
 *   /m/login         → login
 *   /m/course/:id/hole/:n → hole screen (matched by the /m/course prefix)
 */
export class MobileAppComponent extends Component {
    static styles = `
        .m-app {
            height: 100%;
            background: ${t('color-surface-app')};
            color: ${t('color-text-primary')};
        }
    `;

    private router = this.inject(Router);

    render(): DocumentFragment {
        const frag = this.wire(tpl, {});
        this.$swap(this.ref(frag, 'root'), this.router.route, {
            '/m': MobileCourseListComponent,
            '/m/login': MobileLoginComponent,
            '/m/course': MobileHoleComponent,
        }, MobileCourseListComponent);
        return frag;
    }
}
