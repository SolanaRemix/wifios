#!/usr/bin/env bash
# starlink_healthcheck.sh — Starlink bypass-mode health check
# Usage:  ./scripts/starlink_healthcheck.sh [--quiet]
# Exit:   0 = healthy, 1 = degraded (warning only), 2 = critical failure
#
# Suitable for cron / systemd timer.  All output goes to stdout; add
# ">> /var/log/starlink_health.log" in your cron entry to persist history.

set -euo pipefail

# ─── Configuration ──────────────────────────────────────────────────────────
UPLINK_HOSTS="${UPLINK_HOSTS:-8.8.8.8 1.1.1.1}"
DNS_RESOLVER="${DNS_RESOLVER:-8.8.8.8}"
DNS_TEST_DOMAIN="${DNS_TEST_DOMAIN:-google.com}"
PORTAL_URL="${PORTAL_URL:-http://192.168.1.2:3000/pricing}"
PING_COUNT="${PING_COUNT:-3}"
PING_TIMEOUT="${PING_TIMEOUT:-5}"
DNS_TIMEOUT="${DNS_TIMEOUT:-3}"
PORTAL_TIMEOUT="${PORTAL_TIMEOUT:-5}"
# Expected qdisc type; CAKE preferred, fq_codel as fallback
PREFERRED_QDISC="${PREFERRED_QDISC:-cake}"
FALLBACK_QDISC="${FALLBACK_QDISC:-fq_codel}"
# WAN interface name (auto-detected if empty)
WAN_IFACE="${WAN_IFACE:-}"
QUIET="${1:-}"

# ─── Helpers ────────────────────────────────────────────────────────────────
PASS="[PASS]"
FAIL="[FAIL]"
WARN="[WARN]"
INFO="[INFO]"

log()  { [[ "$QUIET" != "--quiet" ]] && echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') $*" || true; }
fail() { echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') $*" >&2; }

overall_status=0  # 0=ok, 1=warn, 2=critical

mark_warn()     { [[ $overall_status -lt 1 ]] && overall_status=1; }
mark_critical() { overall_status=2; }

# ─── Detect WAN interface ────────────────────────────────────────────────────
detect_wan_iface() {
    if [[ -n "$WAN_IFACE" ]]; then
        echo "$WAN_IFACE"
        return
    fi
    # Try to find the interface used by the default route
    local iface
    iface=$(ip route show default 2>/dev/null | awk '/default/ {print $5; exit}')
    if [[ -z "$iface" ]]; then
        iface=$(route -n 2>/dev/null | awk '$1=="0.0.0.0" {print $8; exit}')
    fi
    echo "${iface:-eth0}"
}

WAN_IFACE=$(detect_wan_iface)
log "$INFO Using WAN interface: $WAN_IFACE"

# ─── 1. Uplink Reachability ──────────────────────────────────────────────────
check_uplink() {
    log "$INFO Checking uplink reachability..."
    local any_ok=0
    for host in $UPLINK_HOSTS; do
        if ping -c "$PING_COUNT" -W "$PING_TIMEOUT" -I "$WAN_IFACE" "$host" \
               > /dev/null 2>&1; then
            log "$PASS Uplink reachable via $host"
            any_ok=1
        else
            log "$WARN Uplink unreachable: $host"
        fi
    done
    if [[ $any_ok -eq 0 ]]; then
        fail "$FAIL CRITICAL: No uplink host reachable — Starlink link may be down"
        mark_critical
    fi
}

# ─── 2. DNS Resolver Responsiveness ─────────────────────────────────────────
check_dns() {
    log "$INFO Checking DNS resolver ($DNS_RESOLVER)..."
    if command -v dig &>/dev/null; then
        local result
        if result=$(dig +short +time="$DNS_TIMEOUT" +tries=1 \
                        "@${DNS_RESOLVER}" "$DNS_TEST_DOMAIN" A 2>/dev/null) \
           && grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' <<<"$result"; then
            log "$PASS DNS resolver responsive: $DNS_TEST_DOMAIN -> $result"
        else
            fail "$FAIL CRITICAL: DNS resolver $DNS_RESOLVER returned no valid A record for $DNS_TEST_DOMAIN"
            mark_critical
        fi
    elif command -v nslookup &>/dev/null; then
        if timeout "$DNS_TIMEOUT" nslookup "$DNS_TEST_DOMAIN" "$DNS_RESOLVER" \
               > /dev/null 2>&1; then
            log "$PASS DNS resolver responsive via nslookup"
        else
            fail "$FAIL CRITICAL: DNS resolver $DNS_RESOLVER unresponsive (nslookup)"
            mark_critical
        fi
    else
        log "$WARN dig/nslookup not found — skipping DNS check"
        mark_warn
    fi
}

# ─── 3. Captive Portal Health ────────────────────────────────────────────────
check_portal() {
    log "$INFO Checking captive portal at $PORTAL_URL..."
    if ! command -v curl &>/dev/null; then
        log "$WARN curl not found — skipping portal check"
        mark_warn
        return
    fi
    local http_code
    http_code=$(curl -s -o /dev/null -w "%{http_code}" \
                     --max-time "$PORTAL_TIMEOUT" \
                     --connect-timeout "$PORTAL_TIMEOUT" \
                     "$PORTAL_URL" 2>/dev/null || echo "000")
    if [[ "$http_code" == "200" ]]; then
        log "$PASS Captive portal healthy (HTTP $http_code)"
    elif [[ "$http_code" =~ ^[245] ]]; then
        log "$WARN Captive portal returned HTTP $http_code (non-200 but reachable)"
        mark_warn
    else
        fail "$FAIL CRITICAL: Captive portal unreachable (HTTP $http_code) at $PORTAL_URL"
        mark_critical
    fi
}

# ─── 4. Queue Discipline Check ───────────────────────────────────────────────
check_qdisc() {
    log "$INFO Checking queue discipline on $WAN_IFACE..."
    if ! command -v tc &>/dev/null; then
        log "$WARN tc (iproute2) not found — skipping qdisc check"
        mark_warn
        return
    fi
    local qdisc_output
    qdisc_output=$(tc qdisc show dev "$WAN_IFACE" 2>/dev/null || true)
    if echo "$qdisc_output" | grep -qi "$PREFERRED_QDISC"; then
        log "$PASS Queue discipline: $PREFERRED_QDISC active on $WAN_IFACE"
    elif echo "$qdisc_output" | grep -qi "$FALLBACK_QDISC"; then
        log "$WARN Queue discipline: $FALLBACK_QDISC active (prefer $PREFERRED_QDISC)"
        mark_warn
    else
        fail "$FAIL Queue discipline: neither $PREFERRED_QDISC nor $FALLBACK_QDISC active on $WAN_IFACE"
        fail "$INFO  Current qdisc: $qdisc_output"
        fail "$INFO  Apply with: tc qdisc replace dev $WAN_IFACE root $PREFERRED_QDISC"
        mark_warn
    fi
}

# ─── 5. sysctl / TCP Keepalive Check ─────────────────────────────────────────
check_sysctl() {
    log "$INFO Checking TCP keepalive sysctl settings..."
    if ! command -v sysctl &>/dev/null; then
        log "$WARN sysctl not available — skipping"
        mark_warn
        return
    fi

    local issues=0

    check_sysctl_val() {
        local key="$1" expected_max="$2" label="$3"
        local val
        val=$(sysctl -n "$key" 2>/dev/null || echo "")
        if [[ -z "$val" ]]; then
            log "$WARN sysctl key $key not found"
            return
        fi
        if [[ "$val" -le "$expected_max" ]]; then
            log "$PASS $label: $key = $val (≤ $expected_max)"
        else
            log "$WARN $label: $key = $val (recommended ≤ $expected_max)"
            issues=$((issues + 1))
        fi
    }

    # TCP keepalive — detect silent Starlink link drops quickly
    check_sysctl_val "net.ipv4.tcp_keepalive_time"     120  "Keepalive idle time (s)"
    check_sysctl_val "net.ipv4.tcp_keepalive_intvl"     15  "Keepalive probe interval (s)"
    check_sysctl_val "net.ipv4.tcp_keepalive_probes"     5  "Keepalive probe count"
    check_sysctl_val "net.ipv4.tcp_retries2"             8  "TCP retransmit attempts"

    if [[ $issues -gt 0 ]]; then
        log "$WARN TCP keepalive values sub-optimal; apply with:"
        log "$INFO  sysctl -w net.ipv4.tcp_keepalive_time=120"
        log "$INFO  sysctl -w net.ipv4.tcp_keepalive_intvl=15"
        log "$INFO  sysctl -w net.ipv4.tcp_keepalive_probes=5"
        log "$INFO  sysctl -w net.ipv4.tcp_retries2=8"
        mark_warn
    fi
}

# ─── 6. Summary ──────────────────────────────────────────────────────────────
print_summary() {
    echo "---"
    case $overall_status in
        0) log "$PASS All health checks passed — Starlink backhaul nominal" ;;
        1) log "$WARN One or more warnings — system degraded but operational" ;;
        2) fail "$FAIL CRITICAL failure(s) detected — intervention required" ;;
    esac
    echo "---"
}

# ─── Run all checks ──────────────────────────────────────────────────────────
check_uplink
check_dns
check_portal
check_qdisc
check_sysctl
print_summary

exit $overall_status
