gls_sd_conv.js

==========

Скрипт, конвертирующий исходные файлы .gls в словари StarDict и обратно.

Требуется [Node.js](https://nodejs.org/) начиная с версии 6.0.

Запуск в командной строке:

`node gls_sd_conv.js dictionary.gls`
или
`node gls_sd_conv.js dictionary.ifo`

В первом случае файл .gls должен быть в кодировке UTF-8.

Во втором случае вместе с файлом `dictionary.ifo` в одной папке должны быть файлы `dictionary.idx` (или `dictionary.idx.gz`) и `dictionary.dict` (или `dictionary.dict.dz`). Также при наличии будет обработан файл `dictionary.syn`. Поддерживаются словари StarDict с параметрами `sametypesequence=h` и `idxoffsetbits=32` (или с опущением последнего параметра, что производит один и тот же эффект).

Результат будет иметь одно имя с заданным исходным файлом и будет создан в одной с ним папке.

Если `dictzip` ([для Windows](https://github.com/Tvangeste/dictzip-win32/releases), [для Linux](http://linuxcommand.org/man_pages/dictd8.html)) доступен из текущей папки или системного пути (например, помещён в `C:\Windows\System32`), файл `.dict` будет автоматически сжат с его помощью при конвертации из GLS в StarDict.