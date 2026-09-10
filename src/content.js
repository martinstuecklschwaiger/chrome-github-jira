let jiraLogo = chrome.runtime.getURL("images/jira.png");
let jiraUrl = '';
let acceptanceStartString = 'h3. Acceptance Criteria';
let acceptanceEndString  = 'h3. Notes';
let prTemplate = `
    ### Fix {{TICKETNUMBER}}
    Link to ticket: {{TICKETURL}}

    ### What has been done
    -
    -

    ### How to test
    -
    -

    ### Acceptance criteria
    {{ACCEPTANCE}}

    ### Todo
    - [ ]
    - [ ]

    ### Notes
    -
    -
`;
let prTemplateEnabled = true;
let prTitleEnabled = true;

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
const PAGE_PR_CREATE = 'PAGE_PR_CREATE';

const GITHUB_PAGE_PULL = /github\.com\/(.*)\/(.*)\/pull\//
const GITHUB_PAGE_PULLS = /github\.com\/(.*)\/(.*)\/pulls/
const GITHUB_PAGE_COMPARE = /github\.com\/(.*)\/(.*)\/compare\/(.*)/

// Events GitHub fires after a client-side navigation. `soft-nav:end` is what the
// current React-rendered pages emit; `turbo:render` and `pjax:end` are kept for
// pages (and GitHub Enterprise versions) still served by the older stack.
const NAVIGATION_EVENTS = ['soft-nav:end', 'turbo:render', 'pjax:end']

// The PR header is a React subtree that keeps committing while the page loads
// its timeline, checks and status. Anything written into it before those
// commits finish gets reconciled away, so the injection is watched and
// re-applied. Scoped to the header (~80 nodes) rather than document.body
// (~3600), which is what made the original observer expensive.
const PAGE_HEADER_SELECTOR = '[class^="prc-PageHeader-PageHeader"]'
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

function titleHTMLContent(title, issueKey) {
    return title.replace(/([A-Z0-9]+-[0-9]+)/, `
        <a href="${getJiraUrl(issueKey)}" target="_blank" alt="Ticket in Jira">${issueKey}</a>
    `);
}


function userHTMLContent(text, user) {
    if (user && typeof user === 'object') {
        const { avatarUrls, displayName } = user
        return `
            <div class="d-inline-block">
                ${text}
                <span class="author text-bold">
                    <a class="no-underline"><img style="float:none;margin-right:0" class="avatar avatar-user" src="${avatarUrls['16x16']}" width="20"/></a>
                    ${displayName}
                </span>
            </div>
        `
    }
    return ''
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
    if (!statusIcon) {
        return ''
    }

    const origin = new URL(statusIcon).origin
    const base = new URL(origin).href

    // If the icon is the same as its origin, it most probably is not an image
    if (statusIcon === origin || statusIcon === base) {
        return ''
    }

    return `<img height="16" class="octicon" width="12" aria-hidden="true" src="${statusIcon}"/>`
}

function statusCategoryColors(statusCategory) {
    // There are only "blue", "green", and "grey" in Jira
    switch (statusCategory.colorName) {
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
        reporter,
        status: { iconUrl: statusIcon, name: statusName, statusCategory } = {},
        summary
    } = {}
) {
    const issueUrl = getJiraUrl(issueKey)
    const statusIconHTML = statusIconBlock(statusIcon)
    const { color: statusColor, background: statusBackground } = statusCategoryColors(statusCategory);
    return `
        <div class="TableObject">
            <div class="TableObject-item">
                <span class="State State--green" style="background-color: rgb(150, 198, 222);">
                    <img height="16" class="octicon" width="12" aria-hidden="true" src="${jiraLogo}"/>
                    <a style="color:white;" href="${issueUrl}" target="_blank">Jira</a>
                </span>
            </div>
            <div class="TableObject-item">
                <span class="State State--white" style="color: ${statusColor}; background: ${statusBackground}">
                    ${statusIconHTML}
                    ${statusName}
                </span>
            </div>
            <div class="TableObject-item TableObject-item--primary">
                <strong>
                    <a href="${issueUrl}" target="_blank">
                        ${issueKey} - ${summary}
                    </a>
                </strong>
                <div class="d-inline-block">
                    ${userHTMLContent('Reported by', reporter)}
                    ${userHTMLContent('and assigned to', assignee)}
                </div>
            </div>
        </div>
    `
}

/////////////////////////////////
// FUNCTIONS
/////////////////////////////////

async function main(items) {
    (
        {
            jiraUrl,
            acceptanceStartString,
            acceptanceEndString,
            prTemplateEnabled,
            prTitleEnabled,
            prTemplate
        } = await syncStorage({
            jiraUrl,
            acceptanceStartString,
            acceptanceEndString,
            prTemplateEnabled,
            prTitleEnabled,
            prTemplate
        })
    );

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
        if (page === PAGE_PR_CREATE) handlePrCreatePage();
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

    if (url.match(GITHUB_PAGE_COMPARE) != null) {
        onPageChange(PAGE_PR_CREATE);
    }
}


function handleCommitsTitle() {
    const issueKeyPattern = /([A-Z][A-Z0-9]*-[0-9]+)/;

    document.querySelectorAll(COMMIT_TITLE_SELECTORS.join(', ')).forEach((linkEl) => {
        // Already handled - a re-render or a navigation re-runs this over the
        // same nodes.
        if (linkEl.dataset.jiraLinked === 'true') {
            return;
        }

        const match = linkEl.textContent.match(issueKeyPattern);
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

// Re-apply the injection after React has reconciled it away.
function watchHeader() {
    const descriptionEl = document.querySelector('[class^="prc-PageHeader-Description"]');
    const headerEl = descriptionEl && (descriptionEl.closest(PAGE_HEADER_SELECTOR) || descriptionEl.parentElement);
    if (!headerEl || (headerObserver && headerObserver.headerEl === headerEl)) {
        return;
    }

    if (headerObserver) {
        headerObserver.disconnect();
    }

    headerObserver = new MutationObserver(() => {
        clearTimeout(reassertTimer);
        reassertTimer = setTimeout(() => handlePrPage(), REASSERT_DEBOUNCE);
    });
    headerObserver.headerEl = headerEl;
    headerObserver.observe(headerEl, { childList: true, subtree: true });
}

async function handlePrPage() {
    const titleEl = document.querySelector('h1 > span.markdown-title');
    const pageHeaderDescriptionEl = document.querySelector('[class^="prc-PageHeader-Description"]');
    if (!titleEl || !pageHeaderDescriptionEl) {
        // Header hasn't rendered (yet) - nothing to attach to.
        return false;
    }

    const title = titleEl.innerHTML;

    const titleMatch = title.match(/([A-Z0-9]+-[0-9]+)/);
    if (!titleMatch) {
        // Title was found, but ticket number wasn't.
        return false;
    }
    const ticketNumber = titleMatch[1];

    // Keep watching even when nothing needs re-applying, so the observer is
    // re-pointed after a client-side navigation swaps the header element.
    watchHeader();

    if (jiraHeaderIsIntact(ticketNumber)) {
        return false;
    }

    // A stale block belongs to a previous render or a previous PR.
    const staleEl = document.querySelector('#insertedJiraData');
    if (staleEl) {
        staleEl.remove();
    }

    //Replace title with clickable link to jira ticket
    titleEl.innerHTML = titleHTMLContent(title, ticketNumber);

    //Open up a handle for data
    const loadingElement = buildLoadingElement(ticketNumber);
    pageHeaderDescriptionEl.appendChild(loadingElement);

    // Re-rendering can happen several times while the page settles; serve the
    // ticket from cache so each re-apply doesn't hit Jira again.
    if (ticketCache.key === ticketNumber && ticketCache.fields) {
        loadingElement.innerHTML = headerBlock(ticketNumber, ticketCache.fields);
        return true;
    }

    //Load up data from jira
    try {
        const result = await sendMessage({ query: 'getTicketInfo', jiraUrl, ticketNumber })
        if (result.errors) {
            throw new Error(result.errorMessages);
        }
        ticketCache = { key: ticketNumber, fields: result.fields };
        loadingElement.innerHTML = headerBlock(ticketNumber, result.fields);
    } catch(e) {
        console.error('Error fetching data', e)
        loadingElement.innerText = e.message;
    }
}

async function handlePrCreatePage() {
    if (prTitleEnabled == false && prTemplateEnabled == false) {
        return;
    }

    let body = document.querySelector('textarea#pull_request_body');
    if (!body) {
        return;
    }

    if (body.getAttribute('jira-loading') === 'true') {
        return false; //Already loading
    }
    body.setAttribute('jira-loading', 'true');

    const title = document.title;
    let ticketUrl = '**No linked ticket**';
    let acceptanceList = '';
    let ticketNumber = '?';
    if (title) {
        const titleMatch = title.match(/([a-zA-Z]+-[0-9]+)/);
        if (titleMatch) {
            // Found a title, fetch some info from the ticket
            // Get the last one in the list.
            ticketNumber = titleMatch[titleMatch.length - 1];
            ticketUrl = getJiraUrl(ticketNumber);

            //Load up data from jira
            try {
                const {
                    fields: { summary, description: orgDescription },
                    errors = false,
                    errorMessages = false
                } = {} = await sendMessage({ query: 'getTicketInfo', jiraUrl, ticketNumber });
                if (errors) {
                    throw new Error(errorMessages)
                }

                if (prTitleEnabled) {
                    document.querySelector('input#pull_request_title').value = `[${ticketNumber.toUpperCase()}] ${summary}`;
                }

                let description = orgDescription
                if (typeof description == 'string') {
                    description = description.substr(description.indexOf(acceptanceStartString), description.length);
                    description = description.substr(0, description.indexOf(acceptanceEndString));
                    description = description.substr(acceptanceStartString.length, description.length - acceptanceEndString.length);

                    acceptanceList = description.replace(/#/g, '- [ ]').replace(/^\s+|\s+$/g, '');
                }
            } catch(e) {
                console.error('Could not get remote data', e)
            }
        }
    }

    if (prTemplateEnabled && body.value === '') {
        const nextBodyValue = prTemplate
            .replace('{{TICKETURL}}', ticketUrl)
            .replace('{{TICKETNUMBER}}', ticketNumber)
            .replace('{{ACCEPTANCE}}', acceptanceList);
        body.value = nextBodyValue;
    }
}
