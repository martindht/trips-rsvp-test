// Run the app once the page has fully loaded
document.addEventListener('DOMContentLoaded', initApp);

// Start the app by loading all trips
async function initApp() {
    try {
        await loadEvents();
    } catch (error) {
        document.getElementById('eventsGrid').innerHTML = 
            '<div class="error">Error loading trips: ' + error.message + '</div>';
    }
}

// Get trips from the API and show them on the page
async function loadEvents() {
    const events = await fetchEvents();
    displayEvents(events);
}