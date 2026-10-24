import assert from 'node:assert/strict';
import * as React from 'react';
import type { ReactElement, ReactNode } from 'react';
import { afterEach, test, vi } from 'vite-plus/test';
import type { Commit, CursorPaginated, User } from '../../resources/js/types';

let slots: unknown[];
let cursor: number;
let effects: (() => unknown)[];
let layouts: (() => unknown)[];
const listeners = new Map<string, (event: unknown) => void>();
const reload = vi.fn();
vi.doMock('react', () => ({
    ...React,
    useRef: (initial: unknown) => (slots[cursor++] ??= { current: initial }),
    useState: (initial: unknown) => {
        const index = cursor++;
        if (!(index in slots)) slots[index] = initial;
        return [
            slots[index],
            (value: unknown) => {
                slots[index] =
                    typeof value === 'function' ? value(slots[index]) : value;
            },
        ];
    },
    useEffect: (effect: () => unknown) => effects.push(effect),
    useLayoutEffect: (effect: () => unknown) => layouts.push(effect),
}));
vi.doMock('@inertiajs/react', () => ({
    Head: () => null,
    Link: () => null,
    usePage: () => ({ props: { auth: { user: null } } }),
    usePoll: () => ({ stop: vi.fn() }),
    router: {
        on: (name: string, listener: (event: unknown) => void) => {
            listeners.set(name, listener);
            return () => listeners.delete(name);
        },
        reload,
        flushAll: vi.fn(),
    },
}));
vi.doMock('../../resources/js/components/commit-composer-dialog', () => ({
    useCommitDialogClosedCount: () => 0,
}));
vi.doMock('../../resources/js/hooks/use-composer-visibility', () => ({
    useComposerVisibility: vi.fn(),
}));
vi.doMock('../../resources/js/hooks/use-lane-swipe', () => ({
    useLaneSwipe: vi.fn(),
}));
vi.doMock('../../resources/js/hooks/use-last-visit', () => ({
    useLastVisit: () => null,
}));
const { default: Show } = await import('../../resources/js/pages/log/show');
type Element = ReactElement<Record<string, unknown>>;
function elements(node: ReactNode): Element[] {
    if (!React.isValidElement(node)) return [];
    const element = node as Element;
    return [
        element,
        ...React.Children.toArray(element.props.children as ReactNode).flatMap(
            elements,
        ),
    ];
}
afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

function insertAt(offset: number, reduced = false, authors: User[] = []) {
    slots = [];
    listeners.clear();
    reload.mockClear();
    vi.useFakeTimers();
    let scrollY = offset;
    let rowPosition = offset + 80;
    const animate = vi.fn();
    const existing = {
        dataset: { commit: 'existing' },
        isConnected: true,
        getBoundingClientRect: () => ({
            top: rowPosition - scrollY,
            bottom: rowPosition - scrollY + 120,
            height: 120,
        }),
    };
    const fresh = ['one', 'two', 'three'].map((id) => ({
        dataset: { commit: id },
        getBoundingClientRect: () => ({ height: 120 }),
        animate,
    }));
    let rows: unknown[] = [existing];
    vi.stubGlobal('window', {
        get scrollY() {
            return scrollY;
        },
        scrollBy: (_x: number, y: number) => {
            scrollY += y;
        },
        matchMedia: () => ({ matches: reduced }),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
    });
    vi.stubGlobal(
        'ResizeObserver',
        class {
            observe() {}
            disconnect() {}
        },
    );
    vi.stubGlobal(
        'IntersectionObserver',
        class {
            observe() {}
            disconnect() {}
        },
    );
    const commits = (ids: string[]) =>
        ({ data: ids.map((id) => ({ id })) }) as CursorPaginated<Commit>;
    const render = (commits: CursorPaginated<Commit>, count = 0) => {
        cursor = 0;
        effects = [];
        layouts = [];
        const nodes = elements(
            Show({
                log: 'latest',
                commits,
                isRanked: false,
                newCommitsCount: count,
                newCommitAuthors: {
                    users: count > 0 ? authors : [],
                    total: count > 0 ? authors.length : 0,
                },
                suggestions: [],
            }),
        );
        for (const node of nodes) {
            if (typeof node.props.className !== 'string' || !node.props.ref)
                continue;
            const ref = node.props.ref as React.RefObject<unknown>;
            if (node.props.className.includes('log-header'))
                ref.current = { getBoundingClientRect: () => ({ bottom: 52 }) };
            if (node.props.className.includes('log-feed'))
                ref.current = { querySelectorAll: () => rows };
        }
        for (const effect of layouts) effect();
        for (const effect of effects) effect();
        return nodes;
    };
    const pending = render(commits(['existing']), 3);
    vi.advanceTimersByTime(1000);
    const fetching = render(commits(['existing']), 3);
    vi.advanceTimersByTime(700);
    const incoming = commits(['one', 'two', 'three', 'existing']);
    listeners.get('beforeUpdate')!({
        detail: {
            page: {
                component: 'log/show',
                props: { commits: incoming },
                scrollProps: { commits: { reset: true } },
            },
        },
    });
    rowPosition += 360;
    rows = [...fresh, existing];
    render(incoming);
    const finish = () => {
        reload.mock.calls.at(-1)![0].onFinish();
        return render(incoming);
    };
    return {
        pending,
        fetching,
        animate,
        top: existing.getBoundingClientRect().top,
        scrollY,
        finish,
    };
}

for (const offset of [1, 20, 39, 40, 80, 500]) {
    test(`keeps the reading row still when commits arrive ${offset}px from the top`, () => {
        const result = insertAt(offset);

        assert.equal(result.top, 80);
        assert.equal(result.animate.mock.calls.length, 0);
    });
}

test('animates arriving commits at the top without scrolling the page', () => {
    const result = insertAt(0);

    assert.equal(result.scrollY, 0);
    assert.equal(result.animate.mock.calls.length, 3);
    for (const [frames] of result.animate.mock.calls) {
        assert.ok(
            frames.every((frame: Keyframe) => frame.height === undefined),
        );
    }
});

test('respects reduced motion at the top', () => {
    const result = insertAt(0, true);

    assert.equal(result.scrollY, 0);
    assert.equal(result.animate.mock.calls.length, 0);
});

test('keeps the loaded control while new commits are above a shallowly scrolled reader', () => {
    const result = insertAt(20);

    result.finish();

    assert.equal(vi.getTimerCount(), 0);
});

for (const [total, label] of [
    [1, undefined],
    [5, undefined],
    [6, '+1'],
    [7, '+2'],
    [104, '+99'],
    [10000, '99+'],
] as const) {
    test(`previews five authors and caps the overflow badge for ${total} authors`, () => {
        slots = [];
        cursor = 0;
        effects = [];
        layouts = [];
        const authors = Array.from(
            { length: Math.min(total, 5) },
            (_, index) => ({
                id: `author-${index}`,
                name: `Author ${index}`,
                avatar_url: null,
            }),
        ) as import('../../resources/js/types').User[];
        const nodes = elements(
            Show({
                log: 'following',
                commits: { data: [{ id: 'seen' }] } as CursorPaginated<Commit>,
                isRanked: false,
                newCommitsCount: total * 2,
                newCommitAuthors: { users: authors, total },
                suggestions: [],
            }),
        );
        const button = nodes.find((node) => node.type === 'button')!;
        assert.equal(
            button.props['aria-label'],
            `Show ${total * 2} new commits`,
        );
        assert.equal(
            nodes.filter((node) => node.props.user !== undefined).length,
            Math.min(total, 5),
        );
        const badge = nodes.find(
            (node) => node.props.title === `${total - 5} more authors`,
        );
        assert.equal(Boolean(badge), label !== undefined);
        if (badge) {
            assert.equal(badge.props.children, label);
        }
        reload.mockClear();
        (button.props.onClick as () => void)();
        assert.deepEqual(reload.mock.calls[0][0].only, [
            'commits',
            'newCommitsCount',
            'newCommitAuthors',
        ]);
    });
}

test('keeps the announced avatars while fetching and after the author prop clears', () => {
    const authors = [
        { id: 'author', name: 'Demo author', avatar_url: null },
    ] as User[];
    const result = insertAt(500, false, authors);
    const loaded = result.finish();

    for (const nodes of [result.pending, result.fetching, loaded]) {
        const previews = nodes.filter((node) => node.props.user !== undefined);
        assert.equal(previews.length, 1);
        assert.equal((previews[0].props.user as User).id, 'author');
    }
    assert.equal(
        result.fetching.find((node) => node.type === 'button')?.props.disabled,
        true,
    );
    assert.equal(
        loaded.find((node) => node.type === 'button')?.props['aria-label'],
        '3 new commits loaded. Scroll to top',
    );
});
