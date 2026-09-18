const SUPABASE_URL = "https://kldjehhorrxsnkimcbcr.supabase.co";
const SUPABASE_KEY = "sb_publishable_05vh1NrwuJq15KUMbgCbNQ_d0bUeEze";

const supabaseClient =
    window.supabase.createClient(
        SUPABASE_URL,
        SUPABASE_KEY
    );


let tournament = null;
let players = []; // each entry represents a TEAM (of 2 players)
let matches = [];
let liveChannel = null;
let syncInFlight = false;

// Default teams, pre-filled on the setup screen.
const DEFAULT_TEAMS = [
    ["Oskar", "Norris"],
    ["Leo", "Eesah"],
    ["Rayan", "Aurimas"],
    ["Dragomir", "Alex"]
];

const TEAM_COUNT = DEFAULT_TEAMS.length;


// ==========================================
// DOM
// ==========================================

const setupScreen =
    document.getElementById("setupScreen");

const tournamentScreen =
    document.getElementById("tournamentScreen");

const playersSetup =
    document.getElementById("playersSetup");

const bracket =
    document.getElementById("bracket");

const leaderboard =
    document.getElementById("leaderboard");

const historyBtn =
    document.getElementById("historyBtn");

const historyPanel =
    document.getElementById("historyPanel");

const historyOverlay =
    document.getElementById("historyOverlay");

const historyList =
    document.getElementById("historyList");

const closeHistoryBtn =
    document.getElementById("closeHistory");

// ==========================================
// INITIAL SETUP
// ==========================================

function createPlayerInputs() {

    playersSetup.innerHTML = "";

    for (let i = 1; i <= TEAM_COUNT; i++) {

        const defaults =
            DEFAULT_TEAMS[i - 1] || ["", ""];

        const wrapper =
            document.createElement("div");

        wrapper.className =
            "player-input team-input";

        wrapper.innerHTML = `

            <div class="seed">
                ${i}
            </div>

            <div class="team-fields">

                <input
                    id="team-${i}-p1"
                    placeholder="Player A"
                    maxlength="30"
                    value="${defaults[0]}"
                >

                <input
                    id="team-${i}-p2"
                    placeholder="Player B"
                    maxlength="30"
                    value="${defaults[1]}"
                >

            </div>

        `;

        playersSetup.appendChild(wrapper);
    }
}


createPlayerInputs();

// Resume the most recently active tournament after a refresh instead of
// leaving saved data hidden behind the setup screen.
restoreActiveTournament();


// ==========================================
// HELPERS
// ==========================================

function getInitials(name) {

    return name
        .split(" ")
        .map(word => word[0])
        .join("")
        .slice(0, 2)
        .toUpperCase();
}

function getTeamInitials(p1, p2) {

    const first = (p1 && p1[0]) || "";
    const second = (p2 && p2[0]) || "";

    return (first + second).toUpperCase();
}


function showToast(message) {

    const toast =
        document.getElementById("toast");

    toast.textContent = message;

    toast.classList.add("show");

    setTimeout(() => {

        toast.classList.remove("show");

    }, 2500);
}

function saveErrorMessage(error, fallback) {
    const message = error && error.message ? error.message : "";

    return /invalid api key/i.test(message)
        ? "Supabase key is invalid — update SUPABASE_KEY in app.js."
        : fallback;
}


function playerById(id) {

    return players.find(
        player => player.id === id
    );
}


// ==========================================
// CREATE TOURNAMENT
// ==========================================

document
    .getElementById("startTournamentBtn")
    .addEventListener("click", async () => {

        const name =
            document
                .getElementById("tournamentName")
                .value
                .trim() ||
            "Padel 2v2 Tournament";


        const teams = [];

        for (let i = 1; i <= TEAM_COUNT; i++) {

            const p1Input =
                document.getElementById(
                    `team-${i}-p1`
                );

            const p2Input =
                document.getElementById(
                    `team-${i}-p2`
                );

            const p1 =
                p1Input.value.trim();

            const p2 =
                p2Input.value.trim();

            if (!p1) {

                showToast(
                    `Enter Player A's name for Team ${i}`
                );

                p1Input.focus();

                return;
            }

            if (!p2) {

                showToast(
                    `Enter Player B's name for Team ${i}`
                );

                p2Input.focus();

                return;
            }

            teams.push({
                name: `${p1} & ${p2}`,
                avatar: getTeamInitials(p1, p2)
            });
        }


        try {

            // Only one tournament may be "active" at a time. Archive
            // whichever one currently holds that status (if any) so it
            // still shows up in History, but no longer as the live one.
            const {
                error: archiveError
            } = await supabaseClient
                .from("tournaments")
                .update({ status: "archived" })
                .eq("status", "active");

            if (archiveError)
                throw archiveError;


            // Create tournament

            const {
                data: tournamentData,
                error: tournamentError
            } = await supabaseClient
                .from("tournaments")
                .insert({
                    name,
                    status: "active"
                })
                .select()
                .single();


            if (tournamentError)
                throw tournamentError;


            tournament =
                tournamentData;


            // Create teams (stored in the "players" table — one row per team)

            const playerRows =
                teams.map((team, index) => ({
                    tournament_id:
                        tournament.id,

                    name:
                        team.name,

                    seed: index + 1,

                    avatar:
                        team.avatar
                }));


            const {
                data: playerData,
                error: playerError
            } = await supabaseClient
                .from("players")
                .insert(playerRows)
                .select()
                .order("seed");


            if (playerError)
                throw playerError;


            players =
                playerData;


            await createMatches();

            await loadTournament();

            sendLiveUpdate();

            showTournament();

            showToast(
                "Tournament created!"
            );

        } catch (error) {

            console.error(error);

            showToast(
                saveErrorMessage(error, "Could not create tournament.")
            );
        }

    });


// ==========================================
// CREATE BRACKET
// ==========================================

async function createMatches() {
    // Circle-method pairing: every team faces every other team exactly once.
    // With 4 teams this produces 6 fixtures across 3 team-disjoint pairings.
    const pairs = [];
    const rotation = [...players];

    for (let round = 1; round < players.length; round++) {
        for (let i = 0; i < players.length / 2; i++) {
            pairs.push({
                player1_id: rotation[i].id,
                player2_id: rotation[rotation.length - 1 - i].id
            });
        }

        rotation.splice(1, 0, rotation.pop());
    }


    // All matches are played one after another on a single court, so reorder
    // them to minimize how often the same team has to play twice in a row.
    // With an even number of teams this can't always be avoided entirely —
    // see orderForSingleCourt for why — but this keeps it to the unavoidable
    // minimum instead of leaving it to chance.
    const ordered =
        orderForSingleCourt(pairs);


    const rows =
        ordered.map((pair, index) => ({
            tournament_id: tournament.id,
            round: index + 1,
            match_number: index + 1,
            player1_id: pair.player1_id,
            player2_id: pair.player2_id
        }));


    const {
        error
    } = await supabaseClient
        .from("matches")
        .insert(rows);


    if (error)
        throw error;
}


// Greedily orders matches so that, whenever possible, the next match shares
// no team with the one before it. With n teams there are only n-1 fully
// team-disjoint pairings, and any switch between pairings unavoidably repeats
// one team — so for 4 teams the true minimum is exactly 2 back-to-backs
// across the whole schedule. This produces that minimum by always preferring
// a team-disjoint option, and only falling back to a repeat when every
// remaining match shares a team with the last one played.
function orderForSingleCourt(pairs) {

    const remaining = [...pairs];

    const order = [remaining.shift()];

    while (remaining.length) {

        const last =
            order[order.length - 1];

        const lastTeams = new Set([
            last.player1_id,
            last.player2_id
        ]);

        let nextIndex =
            remaining.findIndex(
                pair =>
                    !lastTeams.has(pair.player1_id) &&
                    !lastTeams.has(pair.player2_id)
            );

        if (nextIndex === -1)
            nextIndex = 0;

        order.push(
            remaining.splice(nextIndex, 1)[0]
        );
    }

    return order;
}


// ==========================================
// LOAD
// ==========================================

async function loadTournament() {

    if (!tournament)
        return;


    const {
        data: playerData,
        error: playerError
    } = await supabaseClient
        .from("players")
        .select("*")
        .eq(
            "tournament_id",
            tournament.id
        )
        .order("seed");

    if (playerError)
        throw playerError;


    const {
        data: matchData,
        error: matchError
    } = await supabaseClient
        .from("matches")
        .select("*")
        .eq(
            "tournament_id",
            tournament.id
        )
        .order("round")
        .order("match_number");

    if (matchError)
        throw matchError;


    players =
        playerData || [];

    matches =
        matchData || [];


    render();
}

async function restoreActiveTournament() {
    try {
        const {
            data,
            error
        } = await supabaseClient
            .from("tournaments")
            .select("*")
            .eq("status", "active")
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle();

        if (error)
            throw error;

        if (!data)
            return;

        tournament = data;
        await loadTournament();
        showTournament();

    } catch (error) {
        console.error(error);
        showToast(saveErrorMessage(error, "Could not load the saved tournament."));
    }
}


// ==========================================
// SHOW TOURNAMENT
// ==========================================

function showTournament() {

    setupScreen.classList.add("hidden");

    tournamentScreen.classList.remove(
        "hidden"
    );
}


// ==========================================
// RENDER
// ==========================================

function render() {

    document.getElementById(
        "tournamentTitle"
    ).textContent =
        tournament.name;


    document.getElementById(
        "playerCount"
    ).textContent =
        players.length;


    const completed =
        matches.filter(
            match =>
                match.status === "completed"
        ).length;


    document.getElementById(
        "matchCount"
    ).textContent =
        matches.length;


    document.getElementById(
        "completedCount"
    ).textContent =
        completed;


    document.getElementById(
        "remainingCount"
    ).textContent =
        matches.length - completed;


    renderBracket();

    renderLeaderboard();

    checkWinner();
}


// ==========================================
// BRACKET
// ==========================================

function renderBracket() {

    bracket.innerHTML = "";

    bracket.classList.add("round-robin");

    matches.forEach(match => {
        bracket.appendChild(createMatchCard(match));
    });
}


// ==========================================
// MATCH CARD
// ==========================================

function createMatchCard(match) {

    const card =
        document.createElement("div");

    card.className =
        "match";

    card.dataset.round = match.round;
    card.dataset.match = match.match_number;


    if (match.status === "completed") {

        card.classList.add(
            "completed"
        );

    }


    const p1 =
        playerById(match.player1_id);

    const p2 =
        playerById(match.player2_id);


    const p1Winner =
        match.winner_id ===
        match.player1_id;


    const p2Winner =
        match.winner_id ===
        match.player2_id;


    // Flag a team that just played the immediately preceding match on the
    // schedule — they're walking straight into this one with no rest.
    const previousMatch =
        matches.find(
            item =>
                item.match_number ===
                match.match_number - 1
        );

    const previousTeams =
        previousMatch
            ? [previousMatch.player1_id, previousMatch.player2_id]
            : [];

    const p1NoRest =
        p1 && previousTeams.includes(match.player1_id);

    const p2NoRest =
        p2 && previousTeams.includes(match.player2_id);

    card.innerHTML = `

        <div class="match-header">

            <span>
                MATCH ${match.match_number}
            </span>

            <span>
                ${
                    match.status ===
                    "completed"
                        ? "FINAL"
                        : "OPEN"
                }
            </span>

        </div>


        <div class="
            match-player
            ${p1Winner ? "winner" : ""}
        " data-player-id="${match.player1_id || ""}">

            <div class="player-info">

                <span class="${
                    !p1
                        ? "empty-player"
                        : ""
                }">

                    ${
                        p1
                            ? p1.name
                            : "TBD"
                    }

                </span>

                ${
                    p1NoRest
                        ? '<span class="no-rest-tag">No rest</span>'
                        : ""
                }

            </div>

        </div>


        <div class="
            match-player
            ${p2Winner ? "winner" : ""}
        " data-player-id="${match.player2_id || ""}">

            <div class="player-info">

                <span class="${
                    !p2
                        ? "empty-player"
                        : ""
                }">

                    ${
                        p2
                            ? p2.name
                            : "TBD"
                    }

                </span>

                ${
                    p2NoRest
                        ? '<span class="no-rest-tag">No rest</span>'
                        : ""
                }

            </div>

        </div>

    `;


    if (p1 && p2) {

        card.classList.add("match--selectable");

        card.querySelectorAll(".match-player").forEach(playerRow => {

            playerRow.setAttribute("role", "button");
            playerRow.setAttribute("tabindex", "0");
            playerRow.setAttribute(
                "aria-label",
                match.winner_id === playerRow.dataset.playerId
                    ? "Clear this match result"
                    : match.status === "completed"
                        ? `Change the winner to ${playerRow.querySelector(".player-info span").textContent.trim()}`
                        : `Record ${playerRow.querySelector(".player-info span").textContent.trim()} as the winner`
            );

            const selectWinner = () =>
            {
                if (card.classList.contains("is-saving"))
                    return;

                if (match.winner_id === playerRow.dataset.playerId) {
                    card.classList.add("is-saving");
                    clearMatchResult(match);
                    return;
                }

                card.classList.add("is-saving");
                completeMatch(match, playerRow.dataset.playerId);
            };

            playerRow.addEventListener("click", selectWinner);

            playerRow.addEventListener("keydown", event => {

                if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    selectWinner();
                }

            });

        });

    }


    return card;
}


// ==========================================
// RECORD WINNER
// ==========================================

async function completeMatch(match, winner) {

    const wasCompleted = match.status === "completed";


    const {
        error
    } = await supabaseClient
        .from("matches")
        .update({
            winner_id: winner,
            status: "completed"

        })
        .eq(
            "id",
            match.id
        );


    if (error) {

        console.error(error);

        showToast(
            saveErrorMessage(error, "Could not save match.")
        );

        return;
    }


    showToast(wasCompleted ? "Winner changed · standings updated" : "Winner recorded · 3 points awarded");

    const completedCount = matches.filter(item => item.status === "completed").length + (wasCompleted ? 0 : 1);

    if (completedCount === matches.length) {
        const finishedMatch = {
            ...match,
            winner_id: winner,
            status: "completed"
        };
        const standings = getStandings(matches.map(item => item.id === match.id ? finishedMatch : item));

        await supabaseClient
            .from("tournaments")
            .update({ winner_id: standings[0].player.id, status: "completed" })
            .eq("id", tournament.id);

        tournament = {
            ...tournament,
            winner_id: standings[0].player.id,
            status: "completed"
        };
    }


    await loadTournament();
    sendLiveUpdate();
}

async function clearMatchResult(match) {
    const {
        error
    } = await supabaseClient
        .from("matches")
        .update({
            winner_id: null,
            status: "upcoming"
        })
        .eq("id", match.id);

    if (error) {
        console.error(error);
        showToast(saveErrorMessage(error, "Could not clear this result."));
        return;
    }

    if (tournament.status === "completed") {
        const {
            error: tournamentError
        } = await supabaseClient
            .from("tournaments")
            .update({ winner_id: null, status: "active" })
            .eq("id", tournament.id);

        if (tournamentError) {
            console.error(tournamentError);
            showToast(saveErrorMessage(tournamentError, "Result cleared, but tournament status could not update."));
            return;
        }

        tournament = { ...tournament, winner_id: null, status: "active" };
    }

    showToast("Result cleared · points removed");
    await loadTournament();
    sendLiveUpdate();
}


// ==========================================
// LEADERBOARD
// ==========================================

function getStandings(sourceMatches = matches) {
    const stats = players.map(player => {
        let wins = 0;
        let losses = 0;

        sourceMatches.filter(match => match.status === "completed" &&
            (match.player1_id === player.id || match.player2_id === player.id)
        ).forEach(match => {
            if (match.winner_id === player.id) wins++;
            else losses++;
        });

        return { player, wins, losses, points: wins * 3 };
    });

    return stats.sort((a, b) =>
        b.points - a.points || a.player.seed - b.player.seed
    );
}

function renderLeaderboard() {

    const stats = getStandings();


    leaderboard.innerHTML =
        stats.map(
            (stat, index) => `

                <tr>

                    <td class="rank">
                        ${index + 1}
                    </td>

                    <td>

                        <div class="player-cell">

                            ${stat.player.name}

                        </div>

                    </td>

                    <td>
                        ${stat.wins}
                    </td>

                    <td>
                        ${stat.points}
                    </td>

                    <td>
                        ${stat.losses}
                    </td>

                </tr>

            `
        )
        .join("");
}


// ==========================================
// WINNER
// ==========================================

function checkWinner() {

    if (
        !tournament ||
        tournament.status !==
            "completed"
    ) {

        document
            .getElementById("winnerSection")
            .classList
            .add("hidden");

        document.getElementById("tournamentStatus").textContent = "In progress";
        document.getElementById("statusDot").style.background = "var(--green)";

        return;
    }


    const winner =
        playerById(
            tournament.winner_id
        );


    if (!winner)
        return;


    document.getElementById(
        "winnerName"
    ).textContent =
        winner.name;


    document
        .getElementById(
            "winnerSection"
        )
        .classList.remove(
            "hidden"
        );


    document.getElementById(
        "tournamentStatus"
    ).textContent =
        "Completed";


    document.getElementById(
        "statusDot"
    ).style.background =
        "var(--accent)";
}


// ==========================================
// HISTORY
// ==========================================

function openHistoryPanel() {

    historyPanel.classList.remove("hidden");
    historyOverlay.classList.remove("hidden");

    refreshHistoryList();
}

function closeHistoryPanel() {

    historyPanel.classList.add("hidden");
    historyOverlay.classList.add("hidden");
}

async function refreshHistoryList() {

    if (historyPanel.classList.contains("hidden"))
        return;

    historyList.innerHTML =
        `<p class="history-empty">Loading…</p>`;

    try {

        const {
            data: tournamentsData,
            error
        } = await supabaseClient
            .from("tournaments")
            .select("*")
            .order("created_at", { ascending: false });

        if (error)
            throw error;


        // Completed tournaments store their winner as a player id — fetch
        // those names in one batched query rather than one per row.

        const winnerIds =
            [...new Set(
                tournamentsData
                    .map(item => item.winner_id)
                    .filter(Boolean)
            )];

        let winnerNames = {};

        if (winnerIds.length) {

            const {
                data: winners,
                error: winnerError
            } = await supabaseClient
                .from("players")
                .select("id, name")
                .in("id", winnerIds);

            if (winnerError)
                throw winnerError;

            winnerNames =
                Object.fromEntries(
                    winners.map(
                        winner => [winner.id, winner.name]
                    )
                );
        }

        renderHistoryList(
            tournamentsData || [],
            winnerNames
        );

    } catch (error) {

        console.error(error);

        historyList.innerHTML =
            `<p class="history-empty">Could not load tournaments.</p>`;
    }
}

function renderHistoryList(list, winnerNames) {

    if (!list.length) {

        historyList.innerHTML =
            `<p class="history-empty">No tournaments yet.</p>`;

        return;
    }

    historyList.innerHTML =
        list.map(item => {

            const isCurrent =
                tournament && tournament.id === item.id;

            const meta =
                item.status === "completed" && winnerNames[item.winner_id]
                    ? `Winner: ${winnerNames[item.winner_id]}`
                    : new Date(item.created_at).toLocaleDateString(
                        undefined,
                        { day: "numeric", month: "short", year: "numeric" }
                    );

            return `

                <div
                    class="history-item ${isCurrent ? "current" : ""}"
                    data-id="${item.id}"
                >

                    <div class="history-item-main">

                        <span class="history-item-name">
                            ${item.name}
                        </span>

                        <span class="history-status history-status--${item.status}">
                            ${item.status}
                        </span>

                    </div>

                    <div class="history-item-meta">
                        ${meta}
                    </div>

                    <button
                        class="history-delete"
                        data-id="${item.id}"
                        aria-label="Delete ${item.name}"
                    >
                        Delete
                    </button>

                </div>
            `;

        }).join("");


    historyList
        .querySelectorAll(".history-item")
        .forEach(row => {

            row.addEventListener("click", event => {

                if (event.target.closest(".history-delete"))
                    return;

                openTournamentFromHistory(row.dataset.id);
            });
        });


    historyList
        .querySelectorAll(".history-delete")
        .forEach(button => {

            button.addEventListener("click", async event => {

                event.stopPropagation();

                await deleteTournamentFromHistory(button.dataset.id);
            });
        });
}

async function openTournamentFromHistory(id) {

    try {

        const {
            data,
            error
        } = await supabaseClient
            .from("tournaments")
            .select("*")
            .eq("id", id)
            .single();

        if (error)
            throw error;

        tournament = data;

        await loadTournament();

        showTournament();

        closeHistoryPanel();

    } catch (error) {

        console.error(error);

        showToast(
            saveErrorMessage(error, "Could not open that tournament.")
        );
    }
}

async function deleteTournamentFromHistory(id) {

    const confirmed =
        confirm("Delete this tournament? This cannot be undone.");

    if (!confirmed)
        return;

    const {
        error
    } = await supabaseClient
        .from("tournaments")
        .delete()
        .eq("id", id);

    if (error) {

        console.error(error);

        showToast(
            saveErrorMessage(error, "Could not delete that tournament.")
        );

        return;
    }

    sendLiveUpdate(id, "deleted");


    if (tournament && tournament.id === id) {

        tournament = null;
        players = [];
        matches = [];

        tournamentScreen.classList.add("hidden");
        setupScreen.classList.remove("hidden");

        createPlayerInputs();
    }

    showToast("Tournament deleted.");

    refreshHistoryList();
}


historyBtn.addEventListener(
    "click",
    openHistoryPanel
);

closeHistoryBtn.addEventListener(
    "click",
    closeHistoryPanel
);

historyOverlay.addEventListener(
    "click",
    closeHistoryPanel
);


// ==========================================
// RESET
// ==========================================

document
    .getElementById("resetBtn")
    .addEventListener(
        "click",
        async () => {

            if (!tournament)
                return;


            const confirmed =
                confirm(
                    "Delete this tournament?"
                );


            if (!confirmed)
                return;

            const deletedTournamentId = tournament.id;

            await supabaseClient
                .from("tournaments")
                .delete()
                .eq(
                    "id",
                    tournament.id
                );

            sendLiveUpdate(deletedTournamentId, "deleted");


            tournament = null;

            players = [];

            matches = [];


            tournamentScreen
                .classList
                .add("hidden");


            setupScreen
                .classList
                .remove("hidden");


            createPlayerInputs();

            showToast(
                "Tournament deleted."
            );

            refreshHistoryList();

        }
    );


// ==========================================
// NEW TOURNAMENT
// ==========================================

document
    .getElementById(
        "newTournamentBtn"
    )
    .addEventListener(
        "click",
        () => {

            tournamentScreen
                .classList
                .add("hidden");


            setupScreen
                .classList
                .remove("hidden");


            createPlayerInputs();

        }
    );


// ==========================================
// REALTIME
// ==========================================

function sendLiveUpdate(tournamentId = tournament && tournament.id, action = "changed") {
    if (!liveChannel || !tournamentId)
        return;

    liveChannel.send({
        type: "broadcast",
        event: "tournament-change",
        payload: { tournamentId, action }
    });
}

async function syncLiveTournament(tournamentId = tournament && tournament.id) {
    if (!tournamentId || syncInFlight)
        return;

    syncInFlight = true;

    try {
        const {
            data,
            error
        } = await supabaseClient
            .from("tournaments")
            .select("*")
            .eq("id", tournamentId)
            .maybeSingle();

        if (error)
            throw error;

        if (!data)
            return;

        tournament = data;
        await loadTournament();
        showTournament();

    } catch (error) {
        console.warn("Live sync failed", error);

    } finally {
        syncInFlight = false;
    }
}

liveChannel = supabaseClient
    .channel("tournament-live")
    .on("broadcast", { event: "tournament-change" }, ({ payload }) => {
        if (payload.action === "deleted" && tournament && tournament.id === payload.tournamentId) {
            tournament = null;
            players = [];
            matches = [];
            tournamentScreen.classList.add("hidden");
            setupScreen.classList.remove("hidden");
            createPlayerInputs();
            refreshHistoryList();
            return;
        }

        syncLiveTournament(payload.tournamentId);
        refreshHistoryList();
    })
    .on("postgres_changes", { event: "*", schema: "public", table: "matches" }, () => {
        syncLiveTournament();
    })
    .on("postgres_changes", { event: "*", schema: "public", table: "tournaments" }, () => {
        syncLiveTournament();
        refreshHistoryList();
    })
    .subscribe();

setInterval(() => {
    if (document.visibilityState === "visible") {
        if (tournament) syncLiveTournament();
        else restoreActiveTournament();
    }
}, 5000);

document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && tournament) {
        syncLiveTournament();
    }
});
