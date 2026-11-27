import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { BudgetShell, BudgetGate } from './BudgetShell.js';
import { AddTransactions } from './BudgetAccountsPanel.js';
import { ActionItems, CategoryBar, SpendingPanel, StatusColumn, Tiles } from './BudgetDashboard.js';
import { MonthPicker } from './MonthPicker.js';
import { NetWorthSection } from './NetWorthPanel.js';
import { budgetClient, type BudgetLoad, type DashboardData } from './budget-data.js';
import { currentMonth, today } from './budget-utils.js';

export function OverviewView({ load, month, onMonth, onChanged, accounts }: {
  load: BudgetLoad<DashboardData> | null;
  month: string;
  onMonth: (month: string) => void;
  /** Reloads the dashboard after a balance changes. */
  onChanged: () => Promise<void>;
  /** The "add transactions" panel. A slot, so this view stays free of data fetching. */
  accounts: ReactNode;
}) {
  const data = load?.state === 'ok' ? load.data : null;

  return (
    <>
      <MonthPicker month={month} onMonth={onMonth} />

      <BudgetGate load={load} />

      {data && (
        <>
          <div className="bud-top">
            <Tiles data={data} />
            <div className="bud-top-main">
              <SpendingPanel data={data} />
              <CategoryBar data={data} />
            </div>
          </div>
          <div className="bud-columns">
            <ActionItems data={data} />
            <StatusColumn data={data} column="over" />
            <StatusColumn data={data} column="near" />
            <StatusColumn data={data} column="under" />
          </div>
          <NetWorthSection data={data.netWorth} onChanged={onChanged} />
        </>
      )}

      {load?.state !== 'locked' && <div id="bud-add">{accounts}</div>}
    </>
  );
}

export default function BudgetOverviewPage() {
  const [load, setLoad] = useState<BudgetLoad<DashboardData> | null>(null);
  const [month, setMonth] = useState(() => currentMonth());
  const wanted = useRef(month);

  // Only the answer for the month on screen is applied, so a slow reply cannot show another month's numbers.
  const refresh = useCallback(async (m: string) => {
    const result = await budgetClient.loadDashboard(m, today());
    if (wanted.current === m) setLoad(result);
  }, []);
  const reload = useCallback(() => refresh(wanted.current), [refresh]);

  useEffect(() => {
    wanted.current = month;
    setLoad(null);
    void refresh(month);
  }, [month, refresh]);

  return (
    <BudgetShell active="/budget" wide>
      <OverviewView
        load={load}
        month={month}
        onMonth={setMonth}
        onChanged={reload}
        accounts={<AddTransactions onChanged={() => void reload()} />}
      />
    </BudgetShell>
  );
}
