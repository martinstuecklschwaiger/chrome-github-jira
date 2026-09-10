function loadOptions() {
    chrome.storage.sync.get({ jiraUrl: '' }, function(items) {
        document.getElementById('jiraUrl').value = items.jiraUrl;
    });
}

function saveOptions() {
    chrome.storage.sync.set({
        jiraUrl: document.getElementById("jiraUrl").value,
    }, function() {
        // Update status to let user know options were saved.
        let status = document.getElementById('status');
        status.style.display = 'block';
        window.scrollTo(0, 0);
        setTimeout(function() {
            status.style.display = 'none';
        }, 2000);
    });
}

function clearOptions() {
    // The pr-template keys are gone from the UI but may still be in a user's
    // synced storage from an earlier version, so keep clearing them.
    chrome.storage.sync.remove([
        'jiraUrl', 'prTemplate', 'acceptanceStartString', 'acceptanceEndString', 'prTemplateEnabled',
        'prTitleEnabled'
    ]);
    loadOptions();
    saveOptions();
}

document.addEventListener('DOMContentLoaded', loadOptions);
document.getElementById("save").addEventListener("click", saveOptions);
document.getElementById("clear").addEventListener("click", clearOptions);
