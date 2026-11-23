let jiraUrl = '';

// Watches the PR header for React reverting our injection
let headerObserver = null;
let reassertTimer = null;
// Last Jira payload, so re-asserting after a re-render doesn't refetch
let ticketCache = { key: null, fields: null };

main().catch(err => console.error('Unexpected error', err))

/////////////////////////////////
// CONSTANTS
/////////////////////////////////

const PAGE_PR = 'PAGE_PR';
const PAGE_PULLS = 'PAGE_PULLS';

const GITHUB_PAGE_PULL = /github\.com\/(.*)\/(.*)\/pull\//
const GITHUB_PAGE_PULLS = /github\.com\/(.*)\/(.*)\/pulls/

// Events GitHub fires after a client-side navigation. `soft-nav:end` is what the
// current React-rendered pages emit; `turbo:render` and `pjax:end` are kept for
// pages (and GitHub Enterprise versions) still served by the older stack.
const NAVIGATION_EVENTS = ['soft-nav:end', 'turbo:render', 'pjax:end']

// A Jira issue key: a project key starting with a letter, then the number.
// The looser `[A-Z0-9]+-[0-9]+` this replaces also matched things like
// `123-456`, so a PR titled "Bump 123-456" was read as a ticket reference.
const JIRA_KEY = /([A-Z][A-Z0-9]*-[0-9]+)/

// GitHub renders the PR header server-side, then mounts its React app a
// second or two later and replaces that whole header element. Anything we
// injected goes with it, so the injection is watched and re-applied.
//
// The watch has to be on document.body: a MutationObserver sees mutations to
// its target's descendants, but not the target itself being removed from its
// parent, so an observer pinned to the header goes silent the moment React
// swaps it out.
const REASSERT_DEBOUNCE = 50

// The pull request title in the page header. GitHub swapped the global
// `markdown-title` class for a hashed `markdownTitle__…` one, so both shapes
// are probed. The `h1 >` keeps out the copy of the title in the sticky header.
const PR_TITLE_SELECTORS = [
    'h1 > span.markdown-title',
    'h1 > span[class*="markdownTitle"]',
]

// A row in a commit list. GitHub replaced the `.commit-message` markup with a
// React list, so both shapes are probed.
const COMMIT_ROW_SELECTORS = [
    '.commit-message',
    'li[data-testid="commit-row-item"]',
]

// The title within such a row.
const COMMIT_TITLE_SELECTORS = [
    'code a',
    'a.color-fg-default',
]

// GitHub's autolink references render an issue key as its own anchor with this
// class. When a repository has an autolink configured for the Jira prefix, the
// key is already linked and there is nothing for us to do.
const GITHUB_AUTOLINK_SELECTOR = 'a.issue-link'

// Pull request titles on the list page. The class carries a content hash that
// changes whenever GitHub rebuilds the bundle, and GitHub has since renamed the
// prefix too (`Title-module__anchor--…` became `anchor__…`), so the test id is
// matched alongside the old prefix.
// Autolink references do not apply to pull request titles - only to commit
// messages, issue and pull request bodies, and comments - so the key sits here
// as plain text and there is nothing else linking it.
const PULLS_TITLE_SELECTORS = [
    'a[class*="Title-module__anchor"]',
    'a[data-testid="listitem-title-link"]',
]

/////////////////////////////////
// TEMPLATES
/////////////////////////////////

// Only http(s) URLs are allowed through to an href or src. Anything else -
// javascript:, data:, a malformed string - becomes empty.
function sanitizeUrl(url) {
    if (!url || typeof url !== 'string') {
        return '';
    }

    try {
        const parsed = new URL(url);
        return (parsed.protocol === 'https:' || parsed.protocol === 'http:') ? parsed.href : '';
    } catch {
        return '';
    }
}

// Small helper so the blocks below stay readable while still going through
// textContent rather than innerHTML.
function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    Object.entries(props).forEach(([key, value]) => {
        if (value === '' || value === null || value === undefined) {
            return;
        }
        if (key === 'text') {
            node.textContent = value;
        } else if (key === 'style') {
            node.style.cssText = value;
        } else {
            node.setAttribute(key, value);
        }
    });
    children.filter(Boolean).forEach(child => node.appendChild(child));
    return node;
}

// Wrap the issue key in the title with a link to Jira, operating on the text
// node that holds it. The previous version ran a regex over the element's
// innerHTML, so once the title already contained the link, the first match was
// the key inside the href and the replacement corrupted the markup.
function linkIssueKeyInTitle(titleEl, issueKey) {
    const walker = document.createTreeWalker(titleEl, NodeFilter.SHOW_TEXT);

    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const index = node.nodeValue.indexOf(issueKey);
        if (index === -1) {
            continue;
        }

        const keyNode = node.splitText(index);
        keyNode.nodeValue = keyNode.nodeValue.slice(issueKey.length);
        keyNode.parentNode.insertBefore(
            el('a', {
                href: getJiraUrl(issueKey),
                target: '_blank',
                rel: 'noopener noreferrer',
                title: 'Ticket in Jira',
                text: issueKey,
            }),
            keyNode
        );
        return true;
    }

    return false;
}


function userBlock(text, user) {
    if (!user || typeof user !== 'object') {
        return null
    }

    const { avatarUrls, displayName } = user
    const avatarSrc = sanitizeUrl(avatarUrls && avatarUrls['48x48'])

    return el('div', { style: 'white-space:nowrap' }, [
        document.createTextNode(`${text} `),
        el('span', { class: 'author text-bold' }, [
            avatarSrc
                ? el('a', { class: 'no-underline' }, [
                    el('img', {
                        class: 'avatar avatar-user',
                        width: '20',
                        src: avatarSrc,
                    }),
                ])
                : null,
            document.createTextNode(` ${displayName ?? ''}`),
        ]),
    ])
}

function buildLoadingElement(issueKey) {
    const el = document.createElement('div');
    el.id = 'insertedJiraData';
    el.className = 'jira-header-meta';
    el.style.cssText = 'margin-top:8px;color:var(--fgColor-muted,#59636e)';
    el.dataset.ticket = issueKey;
    el.innerText = `Loading ticket ${issueKey}...`;
    return el;
}

// Jira colors a status by its category key. The API's colorName still carries
// an older scheme ("blue-gray" for To Do, "yellow" for In Progress), so it is
// ignored. The values are the light-theme colors of the design tokens Jira
// uses for each category.
function statusCategoryColors(statusCategory = {}) {
    switch (statusCategory && statusCategory.key) {
        case "indeterminate":
            return { color: "#123263", background: "#CFE1FD", border: "#8FB8F6" }
        case "done":
            return { color: "#37471F", background: "#D3F1A7", border: "#B3DF72" }
        default:
            return { color: "#292A2E", background: "#0515240F", border: "#0B120E24" }
    }
}

// The height of GitHub's own state label ("Open") in the PR header, border
// included, so the chips line up with it.
const CHIP_LAYOUT = 'display:inline-flex;align-items:center;height:32px;box-sizing:border-box'

function headerBlock(issueKey,
    {
        assignee,
        status: { name: statusName, statusCategory } = {},
        summary
    } = {}
) {
    const issueUrl = getJiraUrl(issueKey)
    const { color: statusColor, background: statusBackground, border: statusBorder } = statusCategoryColors(statusCategory);

    return el('div', { style: 'display:flex;flex-wrap:wrap;align-items:center;gap:4px 8px' }, [
        el('span', { class: 'State State--green', style: `${CHIP_LAYOUT};background-color: #1868DB; box-shadow: none` }, [
            el('a', { href: issueUrl, target: '_blank', rel: 'noopener noreferrer', style: 'color:white;font-weight:600', text: 'Jira' }),
        ]),
        el('span', { class: 'State State--white', style: `${CHIP_LAYOUT};color: ${statusColor}; background: ${statusBackground}; border-color: ${statusBorder}; box-shadow: none` }, [
            document.createTextNode(statusName ?? ''),
        ]),
        el('strong', {}, [
            el('a', {
                href: issueUrl,
                target: '_blank',
                rel: 'noopener noreferrer',
                text: summary ?? '',
            }),
        ]),
        userBlock('Assigned to', assignee),
    ])
}

/////////////////////////////////
// FUNCTIONS
/////////////////////////////////

async function main(items) {
    ({ jiraUrl } = await syncStorage({ jiraUrl }));

    if (jiraUrl == '') {
        console.error('GitHub Jira plugin could not load: Jira URL is not set. Please set the correct Jira URL in the options page.');
        return;
    }

    try {
        // Checks the login
        const { name } = await sendMessage({ query: 'getSession', jiraUrl });

        // Hook into GitHub's client-side navigation events.
        NAVIGATION_EVENTS.forEach((eventName) => {
            document.addEventListener(eventName, checkPage, { passive: true });
        });

        // Check page initially (on first load)
        checkPage();
    } catch(e) {
        console.error(`You are not logged in to Jira at ${jiraUrl} - Please login.`);
        console.error(e);
    }
}


function getJiraUrl(route = '') {
    return `https://${jiraUrl}/browse/${route}`
}

async function syncStorage(data) {
    return new Promise((resolve, reject) => {
        chrome.storage.sync.get(data, resolve);
    })
}

async function sendMessage(data) {
    return new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(data, resolve);
    })
}


function onPageChange(page) {
    setTimeout(function() {
        handleCommitsTitle();
        if (page === PAGE_PR) handlePrPage();
        if (page === PAGE_PULLS) handlePullsListPage();
    }, 200); //Small timeout for dom to finish setup
}

function checkPage() {
    let url = window.location.href;
    if (url.match(GITHUB_PAGE_PULL) != null) {
        onPageChange(PAGE_PR)
    }

    if (url.match(GITHUB_PAGE_PULLS) != null) {
        onPageChange(PAGE_PULLS);
    }
}


function jiraKeyLink(issueKey, style) {
    return el('a', {
        href: getJiraUrl(issueKey),
        target: '_blank',
        rel: 'noopener noreferrer',
        title: 'Ticket in Jira',
        class: 'jira-commit-link',
        style: `${style};font-weight:600;white-space:nowrap`,
        text: issueKey,
    });
}

// Remove a leading issue key from a title, returning whether it was there.
// The key is looked for in the first non-empty text node, so a title that
// mentions the key further along is left alone - stripping it from the middle
// and re-inserting it at the front would reorder the words.
function stripLeadingIssueKey(titleEl, issueKey) {
    const walker = document.createTreeWalker(titleEl, NodeFilter.SHOW_TEXT);

    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!node.nodeValue.trim()) {
            continue;
        }
        if (node.nodeValue.trimStart().indexOf(issueKey) !== 0) {
            return false;
        }
        node.nodeValue = node.nodeValue.trimStart().slice(issueKey.length).trimStart();
        return true;
    }

    return false;
}

// Link the ticket beside a title. These titles are React-owned anchors and an
// <a> inside an <a> is invalid HTML the parser drops, so the link has to be a
// sibling rather than wrapping the key in place.
//
// Where the key leads the title it is lifted out and the link placed in front,
// which is what GitHub's own autolink references do - the remaining title then
// reads "| Some summary". Anywhere else the key stays put and the link is
// appended, so the words keep their order.
function appendJiraLink(titleEl, issueKey) {
    if (stripLeadingIssueKey(titleEl, issueKey)) {
        titleEl.insertAdjacentElement('beforebegin', jiraKeyLink(issueKey, 'margin-right:6px'));
        return;
    }

    titleEl.insertAdjacentElement('afterend', jiraKeyLink(issueKey, 'margin-left:6px'));
}

function handleCommitsTitle() {
    document.querySelectorAll(COMMIT_ROW_SELECTORS.join(', ')).forEach((rowEl) => {
        // Already looked at - a re-render or a navigation re-runs this over the
        // same nodes.
        if (rowEl.dataset.jiraChecked === 'true') {
            return;
        }
        rowEl.dataset.jiraChecked = 'true';

        // GitHub already linked the key itself. Adding a second link would
        // duplicate it, so leave the row alone.
        if (rowEl.querySelector(GITHUB_AUTOLINK_SELECTOR)) {
            return;
        }

        const linkEl = rowEl.querySelector(COMMIT_TITLE_SELECTORS.join(', '));
        if (!linkEl) {
            return;
        }

        const match = linkEl.textContent.match(JIRA_KEY);
        if (!match) {
            return;
        }

        appendJiraLink(linkEl, match[1]);
    });
}

// The pull request list. GitHub shows the key in each title but does not link
// it, so this is the one list where there is something to add.
function handlePullsListPage() {
    document.querySelectorAll(PULLS_TITLE_SELECTORS.join(', ')).forEach((linkEl) => {
        if (linkEl.dataset.jiraChecked === 'true') {
            return;
        }
        linkEl.dataset.jiraChecked = 'true';

        if (linkEl.parentElement && linkEl.parentElement.querySelector(GITHUB_AUTOLINK_SELECTOR)) {
            return;
        }

        const match = linkEl.textContent.match(JIRA_KEY);
        if (!match) {
            return;
        }

        appendJiraLink(linkEl, match[1]);
    });
}

// True when both halves of the injection are still on the page. React can
// revert the title while leaving the details block, so check each separately.
function jiraHeaderIsIntact(ticketNumber) {
    const injectedEl = document.querySelector('#insertedJiraData');
    if (!injectedEl || injectedEl.dataset.ticket !== ticketNumber) {
        return false;
    }

    const titleEl = document.querySelector(PR_TITLE_SELECTORS.join(', '));
    if (titleEl && !titleEl.querySelector(`a[href^="${getJiraUrl('')}"]`)) {
        return false;
    }

    return true;
}

// Re-apply the injection after React has replaced the header.
function watchDocument() {
    if (headerObserver) {
        return;
    }

    headerObserver = new MutationObserver(() => {
        // Trailing throttle rather than a resetting debounce: document-wide
        // mutations arrive in long bursts, and a debounce that restarts on
        // every batch would keep pushing the work further out.
        if (reassertTimer) {
            return;
        }
        reassertTimer = setTimeout(() => {
            reassertTimer = null;
            handlePrPage();
            // List rows arrive after load and change when the list is filtered
            // or paged, neither of which is a navigation. Cheap no-op
            // elsewhere: the selector matches nothing off the list page.
            handlePullsListPage();
        }, REASSERT_DEBOUNCE);
    });
    headerObserver.observe(document.body, { childList: true, subtree: true });
}

async function handlePrPage() {
    const titleEl = document.querySelector(PR_TITLE_SELECTORS.join(', '));
    const pageHeaderDescriptionEl = document.querySelector('[class^="prc-PageHeader-Description"]');
    if (!titleEl || !pageHeaderDescriptionEl) {
        // Header hasn't rendered (yet) - nothing to attach to.
        return false;
    }

    const titleMatch = titleEl.textContent.match(JIRA_KEY);
    if (!titleMatch) {
        // Title was found, but ticket number wasn't.
        return false;
    }
    const ticketNumber = titleMatch[1];

    // Keep watching even when nothing needs re-applying.
    watchDocument();

    if (jiraHeaderIsIntact(ticketNumber)) {
        return false;
    }

    // A stale block belongs to a previous render or a previous PR.
    const staleEl = document.querySelector('#insertedJiraData');
    if (staleEl) {
        staleEl.remove();
    }

    //Replace title with clickable link to jira ticket
    if (!titleEl.querySelector(`a[href^="${getJiraUrl('')}"]`)) {
        linkIssueKeyInTitle(titleEl, ticketNumber);
    }

    //Open up a handle for data
    const loadingElement = buildLoadingElement(ticketNumber);
    pageHeaderDescriptionEl.appendChild(loadingElement);

    // Re-rendering can happen several times while the page settles; serve the
    // ticket from cache so each re-apply doesn't hit Jira again.
    if (ticketCache.key === ticketNumber && ticketCache.fields) {
        loadingElement.replaceChildren(headerBlock(ticketNumber, ticketCache.fields));
        return true;
    }

    //Load up data from jira
    try {
        const result = await sendMessage({ query: 'getTicketInfo', jiraUrl, ticketNumber })
        if (result.errors) {
            throw new Error(result.errorMessages);
        }
        ticketCache = { key: ticketNumber, fields: result.fields };
        loadingElement.replaceChildren(headerBlock(ticketNumber, result.fields));
    } catch(e) {
        console.error('Error fetching data', e)
        loadingElement.innerText = e.message;
    }
}
