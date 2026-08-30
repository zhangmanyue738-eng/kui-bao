# -*- coding: utf-8 -*-
"""
cross_check_bazi.py — 跨实现对拍的 Python 侧（lunar-python）
输入：JSON 日期列表（stdin 或文件参数），输出四柱 JSON 到 stdout
用法：python src/cross_check_bazi.py < dates.json
"""
import json
import sys
from lunar_python import Solar


def calc(item):
    y, m, d, h, gender = item['y'], item['m'], item['d'], item['h'], item['g']
    ec = Solar.fromYmdHms(y, m, d, h, 0, 0).getLunar().getEightChar()
    yun = ec.getYun(1 if gender == '男' else 0)
    dayun = [dy.getGanZhi() for dy in yun.getDaYun()[:6]]
    return {
        'key': item['key'],
        'year': ec.getYear(), 'month': ec.getMonth(), 'day': ec.getDay(), 'hour': ec.getTime(),
        'dayGan': ec.getDayGan(),
        'naYin': [ec.getYearNaYin(), ec.getMonthNaYin(), ec.getDayNaYin(), ec.getTimeNaYin()],
        'dayun': dayun,
        'startYear': yun.getStartYear(),
    }


if __name__ == '__main__':
    items = json.load(sys.stdin)
    print(json.dumps([calc(i) for i in items], ensure_ascii=False))
