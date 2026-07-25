import { di, Router, Theme, startApp, effect } from '@basics/core/client/core';
import { AuthService } from '@basics/core/client/auth';
import { pushContext } from '@basics/core/client/error-report';
import '../design-tokens.css';
import '../theme';
import { guardMobileRoute } from './guard';
import { MobileAppComponent } from './app/mobile-app.component';

// Same DI container + design tokens as the desktop app; the mobile entry only
// swaps the root component and the route guard. Tree-shaking keeps the editor
// out of this bundle (nothing here imports editor/draw/import/map-build).
di.get(Theme);
const router = di.get(Router);
const auth = di.get(AuthService);

await startApp(MobileAppComponent, '#app', {
    hot: import.meta.hot,
    onInit: async () => {
        effect(() => {
            pushContext({ type: 'navigation', detail: router.route.get(), timestamp: new Date().toISOString() });
        });
        await auth.load();
        const redirect = guardMobileRoute(auth.currentUser.get(), router.route.get());
        if (redirect) router.navigate(redirect, true);
    },
});
