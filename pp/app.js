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
    // Circle-method schedule: every team faces every other team exactly once.
    // With 4 teams this produces 3 rounds of 2 fixtures (6 matches total).
    const rows = [];
    let matchNumber = 1;
    const rotation = [...players];

    for (let round = 1; round < players.length; round++) {
        for (let i = 0; i < players.length / 2; i++) {
            rows.push({
                tournament_id: tournament.id,
                round,
                match_number: matchNumber++,
                player1_id: rotation[i].id,
                player2_id: rotation[rotation.length - 1 - i].id
            });
        }

        rotation.splice(1, 0, rotation.pop());
    }


    const {
        error
    } = await supabaseClient
        .from("matches")
        .insert(rows);


    if (error)
        throw error;
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
            return;
        }

        syncLiveTournament(payload.tournamentId);
    })
    .on("postgres_changes", { event: "*", schema: "public", table: "matches" }, () => {
        syncLiveTournament();
    })
    .on("postgres_changes", { event: "*", schema: "public", table: "tournaments" }, () => {
        syncLiveTournament();
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
