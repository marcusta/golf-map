import { di, Router, Theme, startApp, effect } from '@basics/core/client/core';
import { AuthService } from '@basics/core/client/auth';
import { pushContext } from '@basics/core/client/error-report';
import './design-tokens.css';
import './theme';
import { guardRoute } from './auth/guard';
import { ServerModeService } from './app/server-mode.service';
import { AppComponent } from './app/app.component';

di.get(Theme);
const router = di.get(Router);
const auth = di.get(AuthService);
const serverMode = di.get(ServerModeService);

await startApp(AppComponent, '#app', {
    hot: import.meta.hot,
    onInit: async () => {
        effect(() => {
            pushContext({ type: 'navigation', detail: router.route.get(), timestamp: new Date().toISOString() });
        });
        // Run mode and session are both needed before the first render:
        // the route map and every builder affordance are gated on the mode
        // (app/server-mode.service.ts), and onInit is awaited before the root
        // component is constructed — so nothing renders on a guessed mode.
        await Promise.all([auth.load(), serverMode.load()]);
        const redirect = guardRoute(auth.currentUser.get(), router.route.get(), serverMode.mode.get());
        if (redirect) router.navigate(redirect, true);
    },
});
