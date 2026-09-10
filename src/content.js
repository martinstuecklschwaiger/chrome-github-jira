let jiraLogo = chrome.runtime.getURL("images/jira.png");
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

// Where commit titles live. GitHub replaced the `.commit-message` markup with a
// React commit list, so both shapes are probed.
const COMMIT_TITLE_SELECTORS = [
    '.commit-message code a',
    'li[data-testid="commit-row-item"] a.color-fg-default',
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
    const avatarSrc = sanitizeUrl(avatarUrls && avatarUrls['16x16'])

    return el('div', { class: 'd-inline-block', style: 'margin-left:8px' }, [
        document.createTextNode(`${text} `),
        el('span', { class: 'author text-bold' }, [
            avatarSrc
                ? el('a', { class: 'no-underline' }, [
                    el('img', {
                        class: 'avatar avatar-user',
                        style: 'float:none;margin-right:0',
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
    el.className = 'gh-header-meta';
    el.dataset.ticket = issueKey;
    el.innerText = `Loading ticket ${issueKey}...`;
    return el;
}

function statusIconBlock(statusIcon) {
    const src = sanitizeUrl(statusIcon)
    if (!src) {
        return null
    }

    // If the icon is the same as its origin, it most probably is not an image
    const origin = new URL(src).origin
    if (src === origin || src === new URL(origin).href) {
        return null
    }

    return el('img', { height: '16', width: '12', class: 'octicon', 'aria-hidden': 'true', src })
}

function statusCategoryColors(statusCategory = {}) {
    // There are only "blue", "green", and "grey" in Jira
    switch (statusCategory && statusCategory.colorName) {
        case "blue":
            return { color: "white", background: "rgb(150, 198, 222)" }
        case "green":
            return { color: "white", background: "#28a745" }
        default:
            return { color: "rgb(40, 40, 40)", background: "rgb(220, 220, 220)" }
    }
}

function headerBlock(issueKey,
    {
        assignee,
        status: { iconUrl: statusIcon, name: statusName, statusCategory } = {},
        summary
    } = {}
) {
    const issueUrl = getJiraUrl(issueKey)
    const { color: statusColor, background: statusBackground } = statusCategoryColors(statusCategory);

    return el('div', { class: 'TableObject' }, [
        el('div', { class: 'TableObject-item' }, [
            el('span', { class: 'State State--green', style: 'background-color: rgb(150, 198, 222);' }, [
                el('img', { height: '16', width: '12', class: 'octicon', 'aria-hidden': 'true', src: jiraLogo }),
                el('a', { href: issueUrl, target: '_blank', rel: 'noopener noreferrer', style: 'color:white;', text: 'Jira' }),
            ]),
        ]),
        el('div', { class: 'TableObject-item' }, [
            el('span', { class: 'State State--white', style: `color: ${statusColor}; background: ${statusBackground}` }, [
                statusIconBlock(statusIcon),
                document.createTextNode(` ${statusName ?? ''}`),
            ]),
        ]),
        el('div', { class: 'TableObject-item TableObject-item--primary' }, [
            el('strong', {}, [
                el('a', {
                    href: issueUrl,
                    target: '_blank',
                    rel: 'noopener noreferrer',
                    text: summary ?? '',
                }),
            ]),
            userBlock('Assigned to', assignee),
        ]),
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
    }, 200); //Small timeout for dom to finish setup
}

function checkPage() {
    let url = window.location.href;
    if (url.match(GITHUB_PAGE_PULL) != null) {
        onPageChange(PAGE_PR)
    }

    if (url.match(GITHUB_PAGE_PULLS) != null) {
        //@todo PR overview page
    }
}


function handleCommitsTitle() {
    document.querySelectorAll(COMMIT_TITLE_SELECTORS.join(', ')).forEach((linkEl) => {
        // Already handled - a re-render or a navigation re-runs this over the
        // same nodes.
        if (linkEl.dataset.jiraLinked === 'true') {
            return;
        }

        const match = linkEl.textContent.match(JIRA_KEY);
        if (!match) {
            return;
        }

        const issueKey = match[1];
        linkEl.dataset.jiraLinked = 'true';

        // Append a sibling link rather than rebuilding the commit anchor's
        // insides. The commit title is a React-owned <a>, and nesting another
        // <a> inside it is invalid HTML that the parser drops.
        const jiraLink = document.createElement('a');
        jiraLink.href = getJiraUrl(issueKey);
        jiraLink.target = '_blank';
        jiraLink.rel = 'noopener noreferrer';
        jiraLink.title = 'Ticket in Jira';
        jiraLink.textContent = issueKey;
        jiraLink.className = 'jira-commit-link';
        jiraLink.style.cssText = 'margin-left:6px;font-weight:600;white-space:nowrap;';

        linkEl.insertAdjacentElement('afterend', jiraLink);
    });
}

// True when both halves of the injection are still on the page. React can
// revert the title while leaving the details block, so check each separately.
function jiraHeaderIsIntact(ticketNumber) {
    const injectedEl = document.querySelector('#insertedJiraData');
    if (!injectedEl || injectedEl.dataset.ticket !== ticketNumber) {
        return false;
    }

    const titleEl = document.querySelector('h1 > span.markdown-title');
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
        }, REASSERT_DEBOUNCE);
    });
    headerObserver.observe(document.body, { childList: true, subtree: true });
}

async function handlePrPage() {
    const titleEl = document.querySelector('h1 > span.markdown-title');
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
