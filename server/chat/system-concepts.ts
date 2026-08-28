import type { GroundingFact, SystemField } from './types/chat.types.js';

const TRUSTED_SYSTEM_CONCEPTS: Readonly<Partial<Record<SystemField, string>>> = {
    capabilities: 'OcuTemp is a facility system for monitoring room conditions, device connectivity, air-conditioning operation, schedules, floor-plan assignments, climate suggestions, and estimated energy use. OcuGuide provides read-only answers from the OcuTemp information permitted for the signed-in user.',
    temperature: 'Temperature is the room temperature reported by an assigned OcuTemp device. It is current only while that device is online.',
    last_known_temperature: 'A last-known temperature is a timestamped historical reading stored by OcuTemp. It must not be described as current.',
    humidity: 'Humidity is the percentage of moisture in the air reported by an assigned OcuTemp room device. It is current only while that device is online.',
    last_known_humidity: 'A last-known humidity value is a timestamped historical reading stored by OcuTemp. It must not be described as current.',
    occupancy: 'Occupancy is the occupied or unoccupied state reported by an assigned OcuTemp device. It is current only while that device is online.',
    last_known_occupancy: 'Last-known occupancy is a timestamped historical device state. It does not prove that the room is occupied now.',
    device_status: 'OcuTemp treats a device as online when its valid last-seen time is under two minutes old, stale from two through five minutes, and offline after five minutes or when no valid last-seen time is available.',
    room_status: 'A room can be configured as active or inactive in OcuTemp. That configured room state is separate from whether its assigned device is online.',
    ac_power: 'AC power state is the on or off state reported by an assigned OcuTemp device. A current state requires the device to be online.',
    override_active: 'An OcuTemp override is active only when its stored active flag is true and its expiry is valid and still in the future. Stored configuration alone does not prove that a physical command was applied.',
    ai_auto_apply: 'The AI auto button controls whether an eligible climate suggestion may be applied automatically by the device. OcuTemp stores this setting, so its configured state can still be checked while the device is offline.',
    schedules: 'OcuTemp schedules are stored weekly room configurations with a day, start time, end time, and subject. They can be read even when the room device is offline.',
    floor_plan_assignment: 'A floor-plan assignment links a configured OcuTemp room to a floor-plan cell. Assignment coverage comes from the room configuration and does not require live telemetry.',
    climate_suggestion: 'A climate suggestion is a stored recommendation written to OcuTemp by the external prediction service. It is not proof that the suggestion was applied.',
    estimated_kwh: 'OcuTemp energy values are estimates derived from recorded device operation. Missing records and recorded zero usage are different outcomes.',
    decision_event: 'A decision event is a recorded OcuTemp operational log entry. It can describe recorded system activity but must not be used to invent an unrecorded physical outcome.',
};

export function trustedSystemConceptFacts(
    partId: GroundingFact['partId'],
    fields: readonly SystemField[],
): GroundingFact[] {
    return [...new Set(fields)].flatMap((field, index) => {
        const statement = TRUSTED_SYSTEM_CONCEPTS[field];
        return statement ? [{ id: `server.${partId}.concept.${index + 1}`, partId, statement }] : [];
    });
}
