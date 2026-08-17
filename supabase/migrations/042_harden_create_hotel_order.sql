-- ============================================================
-- 042_harden_create_hotel_order.sql — friendly validation errors
--
-- The original create_hotel_order RPC casts inputs with `::uuid` and
-- `::int`, which raises cryptic Postgres errors ("invalid input syntax
-- for type uuid") when the AI passes a menu item NAME or a malformed
-- quantity instead of the exact UUID/integer. That generic error made
-- the hotel agent reply with a vague "something went wrong" apology.
--
-- This rebuilds the RPC with explicit checks and clear RAISE messages
-- so the agent can tell the guest what actually went wrong (and fix it).
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE OR REPLACE FUNCTION public.create_hotel_order(
  p_account_id       uuid,
  p_contact_id       uuid,
  p_conversation_id  uuid,
  p_room_or_table    text,
  p_special_instructions text,
  p_items            jsonb   -- [{ menu_item_id: uuid, quantity: int }, ...]
)
RETURNS uuid AS $$
DECLARE
  v_order_id uuid;
  v_total    numeric(10,2) := 0;
  v_item     jsonb;
  v_item_id  text;
  v_quantity int;
  v_menu_row menu_items%ROWTYPE;
BEGIN
  -- Validate top-level inputs with clear messages.
  IF p_room_or_table IS NULL OR trim(p_room_or_table) = '' THEN
    RAISE EXCEPTION 'A room or table number is required';
  END IF;

  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' THEN
    RAISE EXCEPTION 'Items must be a JSON array of {menu_item_id, quantity}';
  END IF;

  -- Create the order shell
  INSERT INTO orders (account_id, contact_id, conversation_id, room_or_table, special_instructions, status)
  VALUES (p_account_id, p_contact_id, p_conversation_id, trim(p_room_or_table), p_special_instructions, 'pending')
  RETURNING id INTO v_order_id;

  -- Iterate items and insert line items
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_item_id := v_item->>'menu_item_id';

    IF v_item_id IS NULL OR v_item_id = '' THEN
      RAISE EXCEPTION 'One of the items is missing menu_item_id';
    END IF;

    IF NOT v_item_id ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN
      RAISE EXCEPTION 'Invalid menu_item_id "%" — must be a valid UUID from the menu', v_item_id;
    END IF;

    -- Lock the menu item row to prevent concurrent availability races
    SELECT * INTO v_menu_row
    FROM menu_items
    WHERE id = v_item_id::uuid
      AND account_id = p_account_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Menu item % not found or not available in this account', v_item_id;
    END IF;

    IF NOT v_menu_row.is_available THEN
      RAISE EXCEPTION 'Menu item "%" is currently unavailable', v_menu_row.name;
    END IF;

    IF (v_item->>'quantity') IS NULL THEN
      RAISE EXCEPTION 'Item "%" is missing quantity', v_item_id;
    END IF;

    BEGIN
      v_quantity := (v_item->>'quantity')::int;
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'Invalid quantity "%" for item "%" — must be a whole number', v_item->>'quantity', v_item_id;
    END;

    IF v_quantity <= 0 THEN
      RAISE EXCEPTION 'Quantity must be a positive number for item "%"', v_item_id;
    END IF;

    INSERT INTO order_items (order_id, account_id, menu_item_id, quantity, price_at_order_time)
    VALUES (
      v_order_id,
      p_account_id,
      v_menu_row.id,
      v_quantity,
      v_menu_row.price
    );

    v_total := v_total + (v_menu_row.price * v_quantity);
  END LOOP;

  -- Update total
  UPDATE orders SET total_price = v_total WHERE id = v_order_id;

  RETURN v_order_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Keep the same tight permissions (service role only).
REVOKE ALL ON FUNCTION public.create_hotel_order(uuid, uuid, uuid, text, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_hotel_order(uuid, uuid, uuid, text, text, jsonb) TO service_role;