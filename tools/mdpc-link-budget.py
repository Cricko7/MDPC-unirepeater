"""Calculate a preliminary downlink and uplink budget for the passive DAS."""

import argparse
import csv
import json
import math
import sys
from pathlib import Path


# UL and DL band edges in MHz. The default uses the upper edges for path loss.
BANDS = {"B1": (1920, 1980, 2110, 2170), "B3": (1710, 1785, 1805, 1880),
         "B7": (2500, 2570, 2620, 2690)}
RESOURCE_BLOCKS = {1.4: 6, 3: 15, 5: 25, 10: 50, 15: 75, 20: 100}
CABLE_LOSSES = [(1800, 15.6), (2000, 16), (2200, 17.3), (2500, 18.6), (2700, 19.7)]
PANEL_GAIN_DB = 8
HANDSET_LOSS_DB = 8
CONNECTION_LOSS_DB = 1.2
HANDSET_UL_DBM = 10


def number(value, label):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError(f"{label}: требуется конечное число")
    return value


def path_loss(frequency, zone):
    cable_loss = next(loss for upper, loss in CABLE_LOSSES if frequency <= upper)
    feeder_loss = zone["splitter_db"] + CONNECTION_LOSS_DB + cable_loss * zone["cable_m"] / 100
    free_space = 32.44 + 20 * math.log10(frequency * zone["distance_m"] / 1000)
    return feeder_loss + free_space + zone["zone_loss_db"] + HANDSET_LOSS_DB - PANEL_GAIN_DB


def carrier_frequencies(operator):
    ul_min, ul_max, dl_min, dl_max = BANDS[operator["band"]]
    bandwidth = number(operator["bandwidth_mhz"], "bandwidth_mhz")
    if bandwidth not in RESOURCE_BLOCKS or (operator["band"] != "B3" and bandwidth < 5):
        raise ValueError(f"{operator['name']}: неподдерживаемая ширина несущей")
    blocks = RESOURCE_BLOCKS[bandwidth]
    if "dl_mhz" not in operator:
        return ul_max, dl_max, blocks
    dl = number(operator["dl_mhz"], "dl_mhz")
    ul = dl - (dl_min - ul_min)
    half = bandwidth / 2
    if not (ul_min + half <= ul <= ul_max - half and dl_min + half <= dl <= dl_max - half):
        raise ValueError(f"{operator['name']}: несущая выходит за границы диапазона")
    return ul, dl, blocks


def calculate(config):
    target = number(config["rsrp_target_dbm"], "rsrp_target_dbm")
    reserve = number(config["design_reserve_db"], "design_reserve_db")
    if reserve < 0:
        raise ValueError("design_reserve_db: запас должен быть неотрицательным")

    zones = config["zones"]
    if {zone["id"] for zone in zones} != {"A1", "A2", "A3", "A4", "A5"} or len(zones) != 5:
        raise ValueError("В сценарии должны быть пять разных зон A1–A5")
    for zone in zones:
        for key in ("cable_m", "distance_m", "splitter_db", "zone_loss_db"):
            if number(zone[key], key) < 0:
                raise ValueError(f"{zone['id']}: {key} должно быть неотрицательным")
        if zone["distance_m"] == 0:
            raise ValueError(f"{zone['id']}: distance_m должно быть больше нуля")

    operators = config["operators"]
    if len(operators) != 5 or len({item["name"] for item in operators}) != 5:
        raise ValueError("В сценарии должны быть пять разных операторов")

    rows = []
    powers = []
    for operator in operators:
        ul, dl, blocks = carrier_frequencies(operator)
        power = number(operator["das_dl_dbm"], "das_dl_dbm")
        powers.append(power)
        rsrp_correction = 10 * math.log10(12 * blocks)
        for zone in zones:
            dl_loss = path_loss(dl, zone) + rsrp_correction
            rsrp = power - dl_loss
            uplink = HANDSET_UL_DBM - path_loss(ul, zone)
            required_power = target + reserve + dl_loss
            rows.append((operator["name"], operator["band"], zone["id"], rsrp,
                         uplink, rsrp - target, required_power, rsrp >= target + reserve))
    peak = max(powers)
    total_power = peak + 10 * math.log10(sum(10 ** ((power - peak) / 10) for power in powers))
    return rows, total_power


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("scenario", nargs="?", type=Path,
                        default=Path(__file__).with_name("mdpc-scenario.json"))
    parser.add_argument("--csv", type=Path, help="Путь для выгрузки результатов")
    args = parser.parse_args()
    try:
        rows, total = calculate(json.loads(args.scenario.read_text(encoding="utf-8-sig")))
    except (OSError, ValueError, TypeError, KeyError) as error:
        parser.error(str(error))

    columns = ("Оператор", "LTE", "Зона", "RSRP DL, дБм", "UL на DAS, дБм",
               "Запас до порога, дБ", "Нужно DL на DAS, дБм", "Цель расчёта")
    formatted = [(*row[:3], *(f"{value:.2f}" for value in row[3:7]),
                  "достигнута" if row[7] else "ниже цели") for row in rows]
    writer = csv.writer(sys.stdout, delimiter=";", lineterminator="\n")
    writer.writerows([columns, *formatted])
    worst = min(rows, key=lambda row: row[3])
    print(f"Суммарная мощность DL на DAS: {total:+.2f} дБм. "
          f"Худшая точка: {worst[0]}, {worst[2]}, RSRP {worst[3]:.2f} дБм.",
          file=sys.stderr)
    if args.csv:
        try:
            with args.csv.open("w", encoding="utf-8-sig", newline="") as stream:
                csv.writer(stream, delimiter=";").writerows([columns, *formatted])
        except OSError as error:
            parser.error(str(error))


if __name__ == "__main__":
    main()
