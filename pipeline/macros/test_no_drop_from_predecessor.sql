-- Fails for every row whose column fell by more than max_drop from the same row of the
-- predecessor version (matched on `by` columns too), and logs each one readably.
-- The model needs agent_key and previous_agent_key.
{% test no_drop_from_predecessor(model, column_name, max_drop=0, by=[]) %}

{% set failures %}
    select
        now.agent_key,
        now.previous_agent_key,
        {% for col in by %}now.{{ col }}, {% endfor %}
        before.{{ column_name }} as before,
        now.{{ column_name }} as now
    from {{ model }} now
    join {{ model }} before
        on before.agent_key = now.previous_agent_key
        {% for col in by %}and before.{{ col }} = now.{{ col }}{% endfor %}
    where before.{{ column_name }} - now.{{ column_name }} > {{ max_drop }}
{% endset %}

{% if execute %}
    {% for row in run_query(failures) %}
        {% set where = row[2:2 + by | length] | join(', ') %}
        {{ log("REGRESSION: " ~ column_name ~ (" in " ~ where if where else "") ~ " fell from "
               ~ (row['before'] * 100) | round(1) ~ "% to " ~ (row['now'] * 100) | round(1)
               ~ "% (allowed drop " ~ (max_drop * 100) | round(1) ~ " points), agent " ~ row['agent_key']
               ~ " vs " ~ row['previous_agent_key'], info=True) }}
    {% endfor %}
{% endif %}

{{ failures }}

{% endtest %}
