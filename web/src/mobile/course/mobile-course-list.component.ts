import { Component, Router, template } from '@basics/core/client/core';
import type { CourseSummary } from '../../../../shared/api/courses.gen';
import { CoursesService } from '../../courses/courses.service';
import { t } from '../../theme';
import { s, card } from '../../css';
import { icon } from '../../ui/icons';

const tpl = template(`
    <div class="m-courses" bind="root" data-testid="m-courses">
        <header class="m-courses__head">
            <h1 class="m-courses__title">${icon('flag', 20)} Courses</h1>
        </header>
        <div class="m-courses__status" bind="status"></div>
        <ul class="m-courses__list" bind="list"></ul>
    </div>
`);

const rowTpl = template(`
    <li class="m-course" bind="row" data-testid="m-course-row">
        <div class="m-course__name" bind="name"></div>
        <div class="m-course__meta" bind="meta"></div>
        <span class="m-course__chev">${icon('chevron-right', 20)}</span>
    </li>
`);

/**
 * Mobile course list: a flat, tappable card list over CoursesService (reused
 * as-is — same session, same cache). No editor affordances (no create, sort,
 * group, or thumbnails); tapping a card opens hole 1 of that course.
 */
export class MobileCourseListComponent extends Component {
    static styles = `
        .m-courses {
            height: 100%;
            overflow-y: auto;
            -webkit-overflow-scrolling: touch;
            padding: calc(${s('lg')} + var(--safe-top)) ${s('lg')} calc(${s('2xl')} + var(--safe-bottom));
            background: ${t('color-surface-app')};

            & .m-courses__head {
                display: flex;
                align-items: center;
                margin-bottom: ${s('lg')};
            }
            & .m-courses__title {
                display: inline-flex;
                align-items: center;
                gap: ${s('sm')};
                margin: 0;
                font-size: 1.4rem;
                color: ${t('color-accent-primary')};
            }

            & .m-courses__status {
                display: none;
                padding: ${s('md')};
                color: ${t('color-text-secondary')};
                font-size: 0.9rem;
            }
            & .m-courses__status.show { display: block; }

            & .m-courses__list {
                list-style: none;
                margin: 0;
                padding: 0;
                display: flex;
                flex-direction: column;
                gap: ${s('md')};
            }

            & .m-course {
                display: flex;
                align-items: center;
                gap: ${s('md')};
                min-height: 64px;
                padding: ${s('md')} ${s('lg')};
                cursor: pointer;
                ${card({ hover: true })}

                &:active { background: ${t('color-surface-raised')}; }

                & .m-course__name {
                    flex: 1;
                    min-width: 0;
                    font-size: 1.05rem;
                    font-weight: 600;
                    color: ${t('color-text-primary')};
                    overflow: hidden;
                    text-overflow: ellipsis;
                    white-space: nowrap;
                }
                & .m-course__meta {
                    font-size: 0.85rem;
                    color: ${t('color-text-secondary')};
                    white-space: nowrap;
                }
                & .m-course__chev {
                    display: inline-flex;
                    color: ${t('color-text-tertiary')};
                }
            }
        }
    `;

    private courses = this.inject(CoursesService);
    private router = this.inject(Router);

    render(): DocumentFragment {
        const frag = this.wire(tpl, {
            status: {
                className: () => {
                    const loading = this.courses.loading.get();
                    const err = this.courses.error.get();
                    const empty = this.courses.store.items.get().length === 0;
                    return (loading || err || empty) ? 'm-courses__status show' : 'm-courses__status';
                },
                textContent: () => {
                    if (this.courses.error.get()) return 'Could not load courses.';
                    if (this.courses.loading.get()) return 'Loading courses...';
                    if (this.courses.store.items.get().length === 0) return 'No courses yet.';
                    return '';
                },
            },
        });

        this.$each(
            this.ref(frag, 'list'),
            () => this.courses.store.items.get(),
            (course) => this.renderRow(course),
            (course) => course.id,
        );

        void this.courses.load();
        return frag;
    }

    private renderRow(course: CourseSummary): HTMLElement {
        const holes = `${course.holeCount} ${course.holeCount === 1 ? 'hole' : 'holes'}`;
        const row = this.wireEl(rowTpl, {
            name: () => course.name,
            meta: () => `${holes} · par ${course.parTotal}`,
            row: {
                'data-course-id': course.id,
                onclick: () => this.router.navigate(`/m/course/${course.id}/hole/1`),
            },
        });
        return row;
    }
}
