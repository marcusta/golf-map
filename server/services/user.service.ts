import type { Kysely, Selectable } from 'kysely';
import type { Database, UsersTable } from '../db/schema';
import { AuthenticationError, type AuthUser } from '@basics/core/server/auth';

export interface User {
    id: string;
    username: string;
}

type UserRow = Selectable<UsersTable>;

export class UserService {
    constructor(private db: Kysely<Database>) {}

    private users() {
        return this.db.selectFrom('users').selectAll();
    }

    private byId(id: string) {
        return this.users().where('id', '=', id);
    }

    private byUsername(username: string) {
        return this.users().where('username', '=', username);
    }

    async register(username: string, password: string): Promise<User> {
        const id = crypto.randomUUID();
        const passwordHash = await Bun.password.hash(password);

        await this.db.insertInto('users').values({
            id,
            username,
            password_hash: passwordHash,
        }).execute();

        return { id, username };
    }

    async verify(username: string, password: string): Promise<AuthUser | null> {
        const row = await this.byUsername(username).executeTakeFirst();
        if (!row) return null;

        const valid = await Bun.password.verify(password, row.password_hash);
        if (!valid) return null;

        return { id: row.id, username: row.username };
    }

    async findById(id: string): Promise<AuthUser | null> {
        const row = await this.byId(id).executeTakeFirst();
        if (!row) return null;
        return { id: row.id, username: row.username };
    }

    async changePassword(userId: string, currentPassword: string, newPassword: string): Promise<void> {
        const row = await this.byId(userId).executeTakeFirst();
        if (!row) throw new Error('User not found');

        const valid = await Bun.password.verify(currentPassword, row.password_hash);
        if (!valid) throw new AuthenticationError('Current password is incorrect');

        const newHash = await Bun.password.hash(newPassword);
        await this.db.updateTable('users')
            .set({ password_hash: newHash })
            .where('id', '=', userId)
            .execute();
    }
}
