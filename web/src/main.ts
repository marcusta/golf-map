import { di, Router, Theme, startApp, effect } from '@basics/core/client/core';
import { AuthService } from '@basics/core/client/auth';
import { pushContext } from '@basics/core/client/error-report';
import './design-tokens.css';
import './theme';
import { guardRoute } from './auth/guard';
import { AppComponent } from './app/app.component';

di.get(Theme);
const router = di.get(Router);
const auth = di.get(AuthService);

await startApp(AppComponent, '#app', {
    hot: import.meta.hot,
    onInit: async () => {
        effect(() => {
            pushContext({ type: 'navigation', detail: router.route.get(), timestamp: new Date().toISOString() });
        });
        await auth.load();
        const redirect = guardRoute(auth.currentUser.get(), router.route.get());
        if (redirect) router.navigate(redirect, true);
    },
});
