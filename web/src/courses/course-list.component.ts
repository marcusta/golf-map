import { Component, Router, template } from '@basics/core/client/core';
import { t } from '../theme';
import { s, btn, listRow, metric, statusTag } from '../css';
import { CoursesService } from './courses.service';

const tpl = template(`
    <div class="courses" bind="root">
        <div class="courses__inner">
            <header class="courses__header">
                <h2>Courses</h2>
                <span bind="total" class="courses__total"></span>
                <span class="courses__spacer"></span>
                <button bind="newCourse" type="button" class="courses__new">New course</button>
            </header>
            <div class="error" bind="error">
                <span bind="errorText"></span>
                <button bind="retry">Retry</button>
            </div>
            <div bind="list" class="courses__list"></div>
        </div>
    </div>
`);

const rowTpl = template(`
    <button bind="row" type="button" class="course-row">
        <span bind="name" class="course-row__name"></span>
        <span bind="holes" class="course-row__holes"></span>
        <span bind="status" class="course-row__status"></span>
        <span bind="revision" class="course-row__revision"></span>
    </button>
`);

export class CourseListComponent extends Component {
    static styles = `
        .courses {
            height: 100%;
            overflow-y: auto;
            padding: ${s('xl')} ${s('2xl')};

            &[inert] { opacity: 0.6; }

            & .courses__inner {
                max-width: 860px;
                margin: 0 auto;
            }

            & .courses__header {
                display: flex;
                align-items: baseline;
                gap: ${s('md')};
                margin-bottom: ${s('lg')};

                & h2 {
                    margin: 0;
                    font-size: 1.5rem;
                    font-weight: 700;
                    letter-spacing: -0.01em;
                    color: ${t('color-text-primary')};
                }
            }

            & .courses__total {
                ${metric()}
                font-size: 0.75rem;
                font-weight: 400;
                color: ${t('color-text-tertiary')};
            }

            & .courses__spacer { flex: 1; }

            & .courses__new {
                padding: ${s('xs')} ${s('md')};
                font-size: 0.8rem;
                ${btn()}
            }

            & .error {
                display: none;
                color: ${t('color-status-negative')};
                font-size: 0.875rem;
                margin-bottom: ${s('md')};
            }
            & .error.show {
                display: flex;
                align-items: center;
                gap: ${s('sm')};
            }
            & .error button { padding: ${s('xs')} ${s('sm')}; font-size: 0.75rem; ${btn()} }

            & .courses__list {
                display: flex;
                flex-direction: column;
                gap: ${s('sm')};
            }

            & .course-row {
                display: grid;
                grid-template-columns: 1fr auto auto auto;
                align-items: center;
                gap: ${s('lg')};
                text-align: left;
                font-family: inherit;
                cursor: pointer;
                ${listRow()}

                & .course-row__name {
                    font-size: 1rem;
                    font-weight: 600;
                    color: ${t('color-text-primary')};
                }

                & .course-row__holes {
                    ${metric()}
                    font-size: 0.75rem;
                    font-weight: 400;
                    color: ${t('color-text-tertiary')};
                }

                & .course-row__status {
                    ${statusTag(t('color-text-tertiary'))}

                    &.published { ${statusTag(t('color-status-positive'))} }
                    &.draft { ${statusTag('var(--data-risk)')} }
                }

                & .course-row__revision {
                    ${metric()}
                    font-size: 0.75rem;
                    font-weight: 400;
                    color: ${t('color-text-tertiary')};
                    min-width: 3ch;
                    text-align: right;
                }
            }
        }
    `;

    private svc = this.inject(CoursesService);
    private router = this.inject(Router);

    render(): DocumentFragment {
        const frag = this.wire(tpl, {
            root: { inert: () => this.svc.loading.get() },
            total: () => {
                const total = this.svc.store.total.get();
                return total ? `${total} course${total === 1 ? '' : 's'}` : '';
            },
            error: { className: () => this.svc.error.get() ? 'error show' : 'error' },
            errorText: () => this.svc.error.get()?.message ?? '',
            retry: { onclick: () => this.svc.load() },
            newCourse: { onclick: () => this.router.navigate('/new') },
        });

        this.$each(this.ref(frag, 'list'), this.svc.store.items, (course, _i, track) => {
            const live = this.svc.store.item(course.id);
            return this.wireEl(rowTpl, {
                row: { onclick: () => this.router.navigate(`/course/${course.id}`) },
                name: () => live.get().name,
                holes: () => `${live.get().holeCount} holes`,
                status: {
                    textContent: () => live.get().status,
                    className: () => `course-row__status ${live.get().status}`,
                },
                revision: () => `r${live.get().revision}`,
            }, track);
        }, course => course.id);

        return frag;
    }

    onMount(): void {
        void this.svc.load();
    }
}
