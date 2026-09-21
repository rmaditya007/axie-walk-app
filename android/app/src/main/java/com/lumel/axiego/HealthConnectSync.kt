package com.lumel.axiego

import android.content.Context
import android.content.Intent
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.PermissionController
import androidx.health.connect.client.permission.HealthPermission
import androidx.health.connect.client.records.StepsRecord
import androidx.health.connect.client.records.metadata.Device
import androidx.health.connect.client.records.metadata.Metadata
import androidx.health.connect.client.request.AggregateRequest
import androidx.health.connect.client.time.TimeRangeFilter
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId

/**
 * Optional, explicit sync with Health Connect (the platform's own store for
 * step/health data, and the successor to the now-sunsetting Google Fit APIs).
 * Nothing here runs unless the user taps "Sync with Health Connect" and
 * grants the Health Connect permission themselves — it's a bonus on top of
 * the always-on notification/step counter, not a requirement for it.
 *
 * Health Connect's own consent screen lets Read and Write be granted
 * independently (the user can tick one and leave the other off), so every
 * operation here checks only the ONE permission it actually needs rather
 * than requiring both — a read-only grant should still make "today's total"
 * and the backfill work, and a write-only grant (unusual, but possible)
 * should still let the app sync its own steps out.
 */
object HealthConnectSync {

    val readPermission: String = HealthPermission.getReadPermission(StepsRecord::class)
    val writePermission: String = HealthPermission.getWritePermission(StepsRecord::class)
    val permissions: Set<String> = setOf(readPermission, writePermission)

    fun isAvailable(context: Context): Boolean =
        HealthConnectClient.getSdkStatus(context) == HealthConnectClient.SDK_AVAILABLE

    private fun client(context: Context): HealthConnectClient? =
        if (isAvailable(context)) HealthConnectClient.getOrCreate(context) else null

    private suspend fun grantedPermissions(context: Context): Set<String> {
        val c = client(context) ?: return emptySet()
        return try {
            c.permissionController.getGrantedPermissions()
        } catch (e: Exception) {
            emptySet()
        }
    }

    suspend fun hasPermissions(context: Context): Boolean =
        grantedPermissions(context).containsAll(permissions)

    suspend fun hasReadPermission(context: Context): Boolean =
        grantedPermissions(context).contains(readPermission)

    suspend fun hasWritePermission(context: Context): Boolean =
        grantedPermissions(context).contains(writePermission)

    /** Public wrapper so the plugin can re-check live grant state after the
     *  consent screen returns, instead of trusting only the parsed result
     *  Intent (see StepCounterPlugin.handleHealthConnectPermissionResult). */
    suspend fun grantedPermissionsPublic(context: Context): Set<String> =
        grantedPermissions(context)

    fun buildPermissionIntent(context: Context): Intent {
        val contract = PermissionController.createRequestPermissionResultContract()
        return contract.createIntent(context, permissions)
    }

    fun parsePermissionResult(resultCode: Int, data: Intent?): Set<String> {
        val contract = PermissionController.createRequestPermissionResultContract()
        return contract.parseResult(resultCode, data)
    }

    /**
     * Writes ONE StepsRecord covering the last 5 minutes worth `delta` extra
     * steps. Health Connect wants a start/end window rather than a bare
     * count, and we only have "N more steps happened recently" from the
     * hardware counter — a 5-minute window is a reasonable approximation for
     * keeping same-day totals in sync, not a precise cadence claim.
     */
    suspend fun writeStepsDelta(context: Context, delta: Int): Boolean {
        if (delta <= 0) return false
        val c = client(context) ?: return false
        return try {
            if (!hasWritePermission(context)) return false
            val end = Instant.now()
            val start = end.minusSeconds(300)
            val zoneOffset = ZoneId.systemDefault().rules.getOffset(end)
            val record = StepsRecord(
                count = delta.toLong(),
                startTime = start,
                endTime = end,
                startZoneOffset = zoneOffset,
                endZoneOffset = zoneOffset,
                metadata = Metadata.autoRecorded(device = Device(type = Device.TYPE_PHONE))
            )
            c.insertRecords(listOf(record))
            true
        } catch (e: Exception) {
            false
        }
    }

    /** Today's step total across every source Health Connect knows about (not just us). */
    suspend fun readTodayTotal(context: Context): Long? {
        val c = client(context) ?: return null
        return try {
            if (!hasReadPermission(context)) return null
            val zone = ZoneId.systemDefault()
            val startOfDay = LocalDate.now(zone).atStartOfDay(zone).toInstant()
            val now = Instant.now()
            val response = c.aggregate(
                AggregateRequest(
                    metrics = setOf(StepsRecord.COUNT_TOTAL),
                    timeRangeFilter = TimeRangeFilter.between(startOfDay, now)
                )
            )
            response[StepsRecord.COUNT_TOTAL] ?: 0L
        } catch (e: Exception) {
            null
        }
    }
}
