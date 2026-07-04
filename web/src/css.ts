export { s, btn, input, card } from '@basics/core/client/ui/css';
import { s, input as inputRecipe } from '@basics/core/client/ui/css';
import { t } from './theme';

/** Label-above-field pattern. Wrap `<label>Text <input/></label>`. */
export const field = () => `
    display: flex;
    flex-direction: column;
    gap: ${s('xs')};
    font-size: 0.8rem;
    font-weight: 600;
    color: ${t('text-muted')};

    & input, & select, & textarea {
        padding: ${s('sm')} ${s('md')};
        font-size: 0.875rem;
        font-family: inherit;
        ${inputRecipe()}
    }
`;

/** Solid primary action button. */
export const primaryBtn = () => `
    border: none;
    border-radius: ${t('radius-pill')};
    background: ${t('primary')};
    color: ${t('primary-text')};
    font-weight: 600;
    cursor: pointer;
    transition: background 0.15s;
    &:hover { background: ${t('primary-hover')}; }
`;
