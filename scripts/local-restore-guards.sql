-- Destructive statements are confined to rolled-back subtransactions in a named restore fixture.
BEGIN;
DO $guards$
BEGIN
  IF current_database() !~ '^rinsed_restore_[0-9]{8}_[0-9]{6}$' THEN
    RAISE EXCEPTION 'Restore guard checks accept only the isolated restored test database';
  END IF;
  IF NOT EXISTS(SELECT FROM launch_coins) OR NOT EXISTS(SELECT FROM financial_fee_events) OR
     NOT EXISTS(SELECT FROM financial_funding) OR NOT EXISTS(SELECT FROM financial_balances) THEN
    RAISE EXCEPTION 'Required restored registry/funding/fee/balance fixtures are missing';
  END IF;
  BEGIN
    UPDATE launch_coins SET mode=mode;
    RAISE EXCEPTION 'Expected immutable launch identity rejection';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'Launch economic identity is immutable' THEN RAISE; END IF;
  END;
  BEGIN
    UPDATE financial_fee_events SET total=total;
    RAISE EXCEPTION 'Expected append-only fee evidence rejection';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'Financial evidence is append-only' THEN RAISE; END IF;
  END;
  BEGIN
    UPDATE financial_balances SET reserved=funded+1,spent=0;
    RAISE EXCEPTION 'Expected over-reservation rejection';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO financial_funding SELECT * FROM financial_funding LIMIT 1;
    RAISE EXCEPTION 'Expected duplicate funding receipt rejection';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  IF NOT EXISTS(SELECT FROM financial_damm_replay_checkpoints) OR NOT EXISTS(SELECT FROM financial_zero_fee_events) THEN
    RAISE EXCEPTION 'Required checkpoint/zero-owned restore fixtures are missing';
  END IF;
  BEGIN
    UPDATE financial_damm_replay_checkpoints SET payload=payload;
    RAISE EXCEPTION 'Expected immutable checkpoint rejection';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'Financial evidence is append-only' THEN RAISE; END IF;
  END;
  BEGIN
    UPDATE financial_zero_fee_events SET realized_net=0;
    RAISE EXCEPTION 'Expected immutable zero-owned fee rejection';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'Financial evidence is append-only' THEN RAISE; END IF;
  END;
END
$guards$;
ROLLBACK;
SELECT '{"restoreGuardsPassed":true,"checks":["immutable_registry","append_only_fees","funded_reservation_cap","duplicate_funding","immutable_checkpoints","immutable_zero_owned_fees"]}';
